import { apply } from './apply';
import { canonical } from '../internal/canonical';
import type { Change } from '../model/change';
import { assertUniqueIds } from '../internal/collections';
import { diff } from './diff';
import type { ColumnConstraint, Schema } from '../model/types';
import { validate, type ValidationError } from './validate';

export type ConflictKind = 'add/add' | 'update/update' | 'delete/update';

export interface Conflict {
  /** Stable within one result — derived from the location in dispute. */
  id: string;
  kind: ConflictKind;
  tableId: string;
  columnId?: string;
  /** What is in dispute: 'existence' | 'name' | 'type' | 'nullable' | 'constraint:<kind>'. */
  aspect: string;
  ours: Change[];
  theirs: Change[];
}

export interface MergeResult {
  /**
   * `base` plus every change the two sides agree on (or only one side made).
   * Conflicted locations stay at their `base` value — resolve them with
   * `resolveMerge`.
   */
  schema: Schema;
  /** The changes from `base` to `schema` — deterministically ordered, feed to migration output. */
  changes: Change[];
  conflicts: Conflict[];
  /**
   * `validate(schema)`. Empty when `base`, `ours` and `theirs` are each valid
   * and no conflicts remain. Non-empty means the two sides are individually
   * fine but jointly inconsistent — e.g. one adds a foreign key to a table the
   * other drops. `conflicts` does not cover those cross-entity cases.
   */
  errors: ValidationError[];
}

/**
 * Three-way merge. `diff`s each side against `base`, applies every
 * non-conflicting change, and reports the rest as `Conflict`s (see
 * ../../../decisions.md). Order of `ours` / `theirs` only swaps the two sides of
 * each conflict; the merged schema is the same either way.
 */
export function merge(base: Schema, ours: Schema, theirs: Schema): MergeResult {
  assertUniqueIds(base, 'merge (base)');
  assertUniqueIds(ours, 'merge (ours)');
  assertUniqueIds(theirs, 'merge (theirs)');

  const oursChanges = diff(base, ours);
  const theirsChanges = diff(base, theirs);

  const conflicts: Conflict[] = [];
  const blockedTables = new Set<string>();
  const blockedColumns = new Set<string>();

  detectDeleteUpdate(oursChanges, theirsChanges, 'ours', conflicts, blockedTables, blockedColumns);
  detectDeleteUpdate(theirsChanges, oursChanges, 'theirs', conflicts, blockedTables, blockedColumns);

  const isBlocked = (change: Change): boolean =>
    blockedTables.has(change.tableId) ||
    ('columnId' in change && blockedColumns.has(columnKey(change.tableId, change.columnId)));

  const oursBySlot = groupBySlot(oursChanges.filter((c) => !isBlocked(c)));
  const theirsBySlot = groupBySlot(theirsChanges.filter((c) => !isBlocked(c)));

  const merged: Change[] = [];
  for (const slot of new Set([...oursBySlot.keys(), ...theirsBySlot.keys()])) {
    const ourSide = oursBySlot.get(slot) ?? [];
    const theirSide = theirsBySlot.get(slot) ?? [];

    if (ourSide.length === 0) merged.push(...theirSide);
    else if (theirSide.length === 0) merged.push(...ourSide);
    else if (sameChangeSet(ourSide, theirSide)) merged.push(...ourSide);
    else conflicts.push(slotConflict(slot, ourSide, theirSide));
  }

  const schema = apply(base, merged);
  return {
    schema,
    changes: diff(base, schema),
    conflicts: sortConflicts(conflicts),
    errors: validate(schema),
  };
}

export interface ResolvedMerge {
  schema: Schema;
  /** `validate(schema)` — a resolution can still produce an invalid schema (e.g. a name collision). */
  errors: ValidationError[];
}

/**
 * Produce the fully merged schema by taking `pick` for every conflict. Every
 * conflict id in `result.conflicts` must have a pick.
 */
export function resolveMerge(
  result: MergeResult,
  picks: Record<string, 'ours' | 'theirs'>,
): ResolvedMerge {
  const extra: Change[] = [];
  for (const conflict of result.conflicts) {
    const pick = picks[conflict.id];
    if (pick === undefined) {
      throw new Error(`resolveMerge: no pick for conflict "${conflict.id}"`);
    }
    extra.push(...(pick === 'ours' ? conflict.ours : conflict.theirs));
  }
  const schema = apply(result.schema, extra);
  return { schema, errors: validate(schema) };
}

// --- delete/update ---------------------------------------------------------

function detectDeleteUpdate(
  dropper: Change[],
  other: Change[],
  dropperSide: 'ours' | 'theirs',
  conflicts: Conflict[],
  blockedTables: Set<string>,
  blockedColumns: Set<string>,
): void {
  for (const change of dropper) {
    if (change.kind === 'drop_table') {
      const otherOnTable = other.filter(
        (c) => c.tableId === change.tableId && c.kind !== 'drop_table',
      );
      if (otherOnTable.length > 0) {
        blockedTables.add(change.tableId);
        conflicts.push(
          sided(dropperSide, {
            id: `T\0${change.tableId}\0existence`,
            kind: 'delete/update',
            tableId: change.tableId,
            aspect: 'existence',
            dropperChanges: [change],
            otherChanges: otherOnTable,
          }),
        );
      }
    } else if (change.kind === 'drop_column') {
      const otherOnColumn = other.filter(
        (c) =>
          c.tableId === change.tableId &&
          'columnId' in c &&
          c.columnId === change.columnId &&
          c.kind !== 'drop_column',
      );
      if (otherOnColumn.length > 0) {
        blockedColumns.add(columnKey(change.tableId, change.columnId));
        conflicts.push(
          sided(dropperSide, {
            id: `C\0${change.tableId}\0${change.columnId}\0existence`,
            kind: 'delete/update',
            tableId: change.tableId,
            columnId: change.columnId,
            aspect: 'existence',
            dropperChanges: [change],
            otherChanges: otherOnColumn,
          }),
        );
      }
    }
  }
}

interface SidedInput {
  id: string;
  kind: ConflictKind;
  tableId: string;
  columnId?: string;
  aspect: string;
  dropperChanges: Change[];
  otherChanges: Change[];
}

function sided(dropperSide: 'ours' | 'theirs', input: SidedInput): Conflict {
  const { dropperChanges, otherChanges, ...rest } = input;
  return dropperSide === 'ours'
    ? { ...rest, ours: dropperChanges, theirs: otherChanges }
    : { ...rest, ours: otherChanges, theirs: dropperChanges };
}

// --- slot grouping --------------------------------------------------------

const SINGLETON_CONSTRAINTS = new Set<ColumnConstraint['kind']>([
  'primary_key',
  'unique',
  'default',
]);

/** `check` and `foreign_key` may legally repeat, so they key by full value. */
function constraintSlot(constraint: ColumnConstraint): string {
  return SINGLETON_CONSTRAINTS.has(constraint.kind) ? constraint.kind : canonical(constraint);
}

function slotOf(change: Change): string {
  switch (change.kind) {
    case 'add_table':
    case 'drop_table':
      return `T\0${change.tableId}\0existence`;
    case 'rename_table':
      return `T\0${change.tableId}\0name`;
    case 'add_column':
    case 'drop_column':
      return `C\0${change.tableId}\0${change.columnId}\0existence`;
    case 'rename_column':
      return `C\0${change.tableId}\0${change.columnId}\0name`;
    case 'change_type':
      return `C\0${change.tableId}\0${change.columnId}\0type`;
    case 'change_nullable':
      return `C\0${change.tableId}\0${change.columnId}\0nullable`;
    case 'add_constraint':
    case 'drop_constraint':
      return `C\0${change.tableId}\0${change.columnId}\0constraint\0${constraintSlot(change.constraint)}`;
  }
}

function groupBySlot(changes: Change[]): Map<string, Change[]> {
  const map = new Map<string, Change[]>();
  for (const change of changes) {
    const slot = slotOf(change);
    const bucket = map.get(slot);
    if (bucket) bucket.push(change);
    else map.set(slot, [change]);
  }
  return map;
}

function slotConflict(slot: string, ours: Change[], theirs: Change[]): Conflict {
  const parts = slot.split('\0');
  const base = { id: slot, ours, theirs };

  if (parts[0] === 'T') {
    const [, tableId, aspect] = parts;
    return { ...base, kind: kindFor(aspect), tableId, aspect };
  }

  const [, tableId, columnId, field, constraintName] = parts;
  const aspect = field === 'constraint' ? `constraint:${constraintName}` : field;
  return { ...base, kind: kindFor(aspect), tableId, columnId, aspect };
}

function kindFor(aspect: string): ConflictKind {
  return aspect === 'existence' ? 'add/add' : 'update/update';
}

// --- helpers -------------------------------------------------------------

function columnKey(tableId: string, columnId: string): string {
  return `${tableId}\0${columnId}`;
}

function sameChangeSet(a: Change[], b: Change[]): boolean {
  if (a.length !== b.length) return false;
  const bKeys = b.map(canonical).sort();
  return a
    .map(canonical)
    .sort()
    .every((key, i) => key === bKeys[i]);
}

function sortConflicts(conflicts: Conflict[]): Conflict[] {
  return [...conflicts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
