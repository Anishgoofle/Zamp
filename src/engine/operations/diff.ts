import { canonical, canonicalize } from '../internal/canonical';
import type { Change } from '../model/change';
import { assertUniqueIds, byId } from '../internal/collections';
import type { Column, Schema, Table } from '../model/types';

/**
 * Turn `before` into `after`, as one flat array of field-level changes in a
 * deterministic order (see ../../../decisions.md). Depends only on schema content,
 * not array ordering. Inputs are not mutated; embedded objects are fresh clones.
 * Throws on duplicate table/column ids (see `assertUniqueIds`).
 */
export function diff(before: Schema, after: Schema): Change[] {
  assertUniqueIds(before, 'diff (before)');
  assertUniqueIds(after, 'diff (after)');

  const changes: Change[] = [];

  const beforeTables = byId(before.tables);
  const afterTables = byId(after.tables);

  for (const [id, table] of beforeTables) {
    if (!afterTables.has(id)) {
      changes.push({ kind: 'drop_table', tableId: id, table: embedTable(table) });
    }
  }
  for (const [id, table] of afterTables) {
    if (!beforeTables.has(id)) {
      changes.push({ kind: 'add_table', tableId: id, table: embedTable(table) });
    }
  }
  for (const [id, afterTable] of afterTables) {
    const beforeTable = beforeTables.get(id);
    if (beforeTable === undefined) continue;

    if (beforeTable.name !== afterTable.name) {
      changes.push({
        kind: 'rename_table',
        tableId: id,
        from: beforeTable.name,
        to: afterTable.name,
      });
    }
    diffColumns(id, beforeTable, afterTable, changes);
  }

  return order(changes);
}

function diffColumns(tableId: string, before: Table, after: Table, out: Change[]): void {
  const beforeColumns = byId(before.columns);
  const afterColumns = byId(after.columns);

  for (const [id, column] of beforeColumns) {
    if (!afterColumns.has(id)) {
      out.push({ kind: 'drop_column', tableId, columnId: id, column: embedColumn(column) });
    }
  }
  for (const [id, column] of afterColumns) {
    if (!beforeColumns.has(id)) {
      out.push({ kind: 'add_column', tableId, columnId: id, column: embedColumn(column) });
    }
  }
  for (const [id, afterColumn] of afterColumns) {
    const beforeColumn = beforeColumns.get(id);
    if (beforeColumn === undefined) continue;

    if (beforeColumn.name !== afterColumn.name) {
      out.push({
        kind: 'rename_column',
        tableId,
        columnId: id,
        from: beforeColumn.name,
        to: afterColumn.name,
      });
    }
    if (canonical(beforeColumn.type) !== canonical(afterColumn.type)) {
      out.push({
        kind: 'change_type',
        tableId,
        columnId: id,
        from: canonicalize(beforeColumn.type),
        to: canonicalize(afterColumn.type),
      });
    }
    if (beforeColumn.nullable !== afterColumn.nullable) {
      out.push({
        kind: 'change_nullable',
        tableId,
        columnId: id,
        from: beforeColumn.nullable,
        to: afterColumn.nullable,
      });
    }
    diffConstraints(tableId, id, beforeColumn, afterColumn, out);
  }
}

function diffConstraints(
  tableId: string,
  columnId: string,
  before: Column,
  after: Column,
  out: Change[],
): void {
  // Keyed by canonical form: a column that (invalidly) repeats an identical
  // constraint collapses to one entry, so diff never emits a duplicate
  // add/drop_constraint. Constraints are a set — see ../../../decisions.md.
  const beforeByKey = new Map(before.constraints.map((c) => [canonical(c), c]));
  const afterByKey = new Map(after.constraints.map((c) => [canonical(c), c]));

  for (const [key, constraint] of beforeByKey) {
    if (!afterByKey.has(key)) {
      out.push({ kind: 'drop_constraint', tableId, columnId, constraint: canonicalize(constraint) });
    }
  }
  for (const [key, constraint] of afterByKey) {
    if (!beforeByKey.has(key)) {
      out.push({ kind: 'add_constraint', tableId, columnId, constraint: canonicalize(constraint) });
    }
  }
}

/**
 * Rank within one (tableId, columnSlot) group. Table- and column-level kinds can
 * reuse numbers — the empty vs. real columnSlot already separates them.
 */
const KIND_RANK: Record<Change['kind'], number> = {
  add_table: 0,
  rename_table: 1,
  drop_table: 2,
  add_column: 0,
  rename_column: 1,
  change_type: 2,
  change_nullable: 3,
  add_constraint: 4,
  drop_constraint: 5,
  drop_column: 6,
};

function order(changes: Change[]): Change[] {
  return changes
    .map((change) => ({ change, key: sortKey(change) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => entry.change);
}

function sortKey(change: Change): string {
  const isTableLevel =
    change.kind === 'add_table' ||
    change.kind === 'drop_table' ||
    change.kind === 'rename_table';
  const columnSlot = isTableLevel ? '' : change.columnId;
  const tiebreak =
    change.kind === 'add_constraint' || change.kind === 'drop_constraint'
      ? canonical(change.constraint)
      : '';
  // NUL separator: opaque ids are not expected to contain it, so ("a b", "")
  // and ("a", "b") can't produce the same key.
  return [
    change.tableId,
    columnSlot,
    String(KIND_RANK[change.kind]).padStart(2, '0'),
    tiebreak,
  ].join('\u0000');
}

// Embedded payloads are fully normalized — object keys sorted (canonicalize),
// columns ordered by id, constraints ordered canonically — so that diff output
// is a pure function of schema content, byte-stable under JSON.stringify.
function embedTable(table: Table): Table {
  const clone = canonicalize(table);
  clone.columns.sort(compareById);
  for (const column of clone.columns) {
    column.constraints.sort(compareCanonical);
  }
  return clone;
}

function embedColumn(column: Column): Column {
  const clone = canonicalize(column);
  clone.constraints.sort(compareCanonical);
  return clone;
}

function compareById(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareCanonical(a: unknown, b: unknown): number {
  const ka = canonical(a);
  const kb = canonical(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}
