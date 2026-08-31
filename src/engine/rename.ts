import { canonical } from './canonical';
import { assertUniqueIds, byId } from './collections';
import type { Column, ColumnConstraint, Schema, Table } from './types';

export interface RenameMatch {
  scope: 'table' | 'column';
  /** Present for columns: the (already reconciled) table id the column lives in. */
  tableId?: string;
  /** The id `before` uses. The returned schema keeps this id. */
  keptId: string;
  /** The id `after` used for the same entity. */
  incomingId: string;
  /** `name` — matched by identical name (ids regenerated); `signature` — matched by structure (a real rename). */
  by: 'name' | 'signature';
}

export interface RenameResult {
  /** A copy of `after` with matched entities' ids reconciled back to `before`. */
  schema: Schema;
  matches: RenameMatch[];
}

/**
 * Heuristic layer for schemas that arrive without stable ids (e.g. parsed from
 * DDL). Aligns `after`'s tables and columns to `before` — first by identical
 * name, then by structural signature for the leftovers (a real rename) — and
 * reuses `before`'s id, so a following `diff` reports `rename_*` or nothing
 * instead of drop + add. Only unambiguous matches are taken; see
 * ../../decisions.md.
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
 * A foreign key holds its target by id. Once entities are reconciled to
 * `before`'s ids, rewrite those references so they point at the kept ids —
 * otherwise a following `diff` sees the FK as changed and `validate` sees it as
 * dangling.
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
        constraint.refTableId = tableIdOf.get(constraint.refTableId) ?? constraint.refTableId;
        constraint.refColumnId =
          columnIdOf.get(constraint.refTableId)?.get(constraint.refColumnId) ??
          constraint.refColumnId;
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

/** Column structure minus id and name — a rename changes only the name. */
function columnSignature(column: Column): string {
  return canonical({
    type: column.type,
    nullable: column.nullable,
    constraints: column.constraints.map(constraintSignature).sort(),
  });
}

/**
 * A foreign key's target ids are regenerated along with everything else in the
 * parsed-DDL case, so matching on them would defeat the point. Reduce an FK to
 * its kind; `remapForeignKeys` fixes the actual references afterwards.
 */
function constraintSignature(constraint: ColumnConstraint): string {
  return constraint.kind === 'foreign_key'
    ? canonical({ kind: 'foreign_key' })
    : canonical(constraint);
}

/**
 * Table structure minus id and name — the multiset of its column signatures.
 * Column *names* are excluded too, so a table that was renamed *and* had a
 * column renamed still matches (the phase-2 uniqueness check guards against
 * matching two unrelated tables that share a column shape).
 */
function tableSignature(table: Table): string {
  return canonical(table.columns.map(columnSignature).sort());
}
