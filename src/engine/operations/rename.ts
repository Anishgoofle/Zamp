import { canonical } from '../internal/canonical.js';
import { assertUniqueIds, byId } from '../internal/collections.js';
import type { Column, ColumnConstraint, Schema, Table } from '../model/types.js';

export interface RenameMatch {
  scope: 'table' | 'column';
  /** Columns only: the already-reconciled table id the column lives in. */
  tableId?: string;
  /** The id `before` uses. The returned schema keeps this id. */
  keptId: string;
  /** The id `after` used for the same entity. */
  incomingId: string;
  /** `name`: matched on an identical name, so ids were regenerated. `signature`: matched on structure, so it's a real rename. */
  by: 'name' | 'signature';
}

export interface RenameResult {
  /** A copy of `after` with matched entities' ids reconciled back to `before`. */
  schema: Schema;
  matches: RenameMatch[];
}

/**
 * Heuristic layer for schemas that arrive without stable ids, e.g. parsed from
 * DDL. Aligns `after`'s tables and columns onto `before`: identical names first,
 * then structural signature for whatever is left over, which is where the real
 * renames turn up. Matched entities take `before`'s id, so the following `diff`
 * reports `rename_*` or nothing instead of a drop and an add.
 *
 * Only unambiguous matches are taken. decisions.md covers why.
 */
export function detectRenames(before: Schema, after: Schema): RenameResult {
  assertUniqueIds(before, 'detectRenames (before)');
  assertUniqueIds(after, 'detectRenames (after)');

  const schema = structuredClone(after);
  const matches: RenameMatch[] = [];

  reconcile(
    before.tables,
    schema.tables,
    (t) => tableSignature(t),
    (from, to) => matches.push({ scope: 'table', keptId: from.id, incomingId: to.id, by: 'name' }),
    (from, to) => matches.push({ scope: 'table', keptId: from.id, incomingId: to.id, by: 'signature' }),
  );

  const beforeTables = byId(before.tables);
  for (const table of schema.tables) {
    const original = beforeTables.get(table.id);
    if (!original) continue;
    reconcile(
      original.columns,
      table.columns,
      (c) => columnSignature(c),
      (from, to) =>
        matches.push({ scope: 'column', tableId: table.id, keptId: from.id, incomingId: to.id, by: 'name' }),
      (from, to) =>
        matches.push({ scope: 'column', tableId: table.id, keptId: from.id, incomingId: to.id, by: 'signature' }),
    );
  }

  remapForeignKeys(schema, matches);

  assertUniqueIds(schema, 'detectRenames (result)');
  return { schema, matches };
}

/**
 * A foreign key holds its target by id, so once entities are reconciled to
 * `before`'s ids those references have to be rewritten too. Skip this and the
 * next `diff` sees the FK as changed and `validate` sees it as dangling.
 */
function remapForeignKeys(schema: Schema, matches: RenameMatch[]): void {
  const tableIdOf = new Map<string, string>();
  const columnIdOf = new Map<string, Map<string, string>>();
  for (const match of matches) {
    if (match.scope === 'table') {
      tableIdOf.set(match.incomingId, match.keptId);
    } else {
      const byTable = columnIdOf.get(match.tableId!) ?? new Map<string, string>();
      byTable.set(match.incomingId, match.keptId);
      columnIdOf.set(match.tableId!, byTable);
    }
  }

  for (const table of schema.tables) {
    for (const column of table.columns) {
      for (const constraint of column.constraints) {
        if (constraint.kind !== 'foreign_key') continue;
        // Resolve the table first and keep it in a local: `columnIdOf` is keyed by
        // the *kept* table id, so reading `constraint.refTableId` back after
        // assigning it would make this depend on statement order.
        const refTableId = tableIdOf.get(constraint.refTableId) ?? constraint.refTableId;
        constraint.refColumnId =
          columnIdOf.get(refTableId)?.get(constraint.refColumnId) ?? constraint.refColumnId;
        constraint.refTableId = refTableId;
      }
    }
  }
}

/**
 * Align `after` records to `before` records in place: exact-name matches first,
 * then unambiguous signature matches on what's left. A matched `after` record
 * takes the `before` record's id.
 */
function reconcile<T extends { id: string; name: string }>(
  before: readonly T[],
  after: T[],
  signature: (record: T) => string,
  onNameMatch: (from: T, to: T) => void,
  onSignatureMatch: (from: T, to: T) => void,
): void {
  const alignedIds = new Set(before.map((r) => r.id));
  const availableBefore = before.filter((r) => !after.some((a) => a.id === r.id));

  const link = (from: T, to: T, report: (from: T, to: T) => void): void => {
    report(from, to);
    to.id = from.id;
    const i = availableBefore.indexOf(from);
    if (i >= 0) availableBefore.splice(i, 1);
  };

  for (const record of after) {
    if (alignedIds.has(record.id)) continue;
    const byName = uniqueMatch(availableBefore, (r) => r.name === record.name);
    if (byName) link(byName, record, onNameMatch);
  }

  for (const record of after) {
    if (alignedIds.has(record.id)) continue;
    const target = signature(record);
    const bySignature = uniqueMatch(availableBefore, (r) => signature(r) === target);
    if (bySignature) link(bySignature, record, onSignatureMatch);
  }
}

/** The sole element matching `predicate`, or undefined if zero or more than one. */
function uniqueMatch<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  const hits = items.filter(predicate);
  return hits.length === 1 ? hits[0] : undefined;
}

/** Column structure minus id and name, since a rename changes only the name. */
function columnSignature(column: Column): string {
  return canonical({
    type: column.type,
    nullable: column.nullable,
    constraints: column.constraints.map(constraintSignature).sort(),
  });
}

/**
 * In the parsed-DDL case an FK's target ids were regenerated along with
 * everything else, so matching on them would defeat the point. Reduce an FK to
 * its kind and let `remapForeignKeys` fix the references afterwards.
 */
function constraintSignature(constraint: ColumnConstraint): string {
  return constraint.kind === 'foreign_key'
    ? canonical({ kind: 'foreign_key' })
    : canonical(constraint);
}

/**
 * Table structure minus id and name: the multiset of its column signatures.
 * Column names are excluded too, so a table that was renamed and also had a
 * column renamed still matches. The uniqueness check in phase 2 is what stops
 * two unrelated tables with the same column shape matching each other.
 */
function tableSignature(table: Table): string {
  return canonical(table.columns.map(columnSignature).sort());
}
