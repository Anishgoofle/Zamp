import { equal } from '../internal/canonical.js';
import type { Change, ColumnChange } from '../model/change.js';
import { assertUniqueIds, byId } from '../internal/collections.js';
import type { Column, Schema, Table } from '../model/types.js';

/**
 * Apply a change list to a schema and return a new one. The input isn't mutated,
 * and `apply(s, diff(s, t))` has no remaining diff to `t`. Changes are mutually
 * independent so order doesn't matter; new tables and columns are appended, and
 * that order isn't significant either (decisions.md).
 *
 * Throws on duplicate ids in `schema` or a change targeting an id that isn't
 * there. Both mean malformed or stale input rather than a recoverable state.
 */
export function apply(schema: Schema, changes: readonly Change[]): Schema {
  assertUniqueIds(schema, 'apply');

  const next = structuredClone(schema);
  const tables = byId(next.tables);

  // Build each table's column map once on first touch and write it back once at
  // the end: K changes to a C-column table cost O(K + C) instead of O(K * C).
  const columnMaps = new Map<string, Map<string, Column>>();
  const columnsOf = (table: Table): Map<string, Column> => {
    let columns = columnMaps.get(table.id);
    if (columns === undefined) {
      columns = byId(table.columns);
      columnMaps.set(table.id, columns);
    }
    return columns;
  };

  for (const change of changes) {
    switch (change.kind) {
      case 'add_table':
        tables.set(change.table.id, structuredClone(change.table));
        break;
      case 'drop_table':
        mustGet(tables, change.tableId, 'table');
        tables.delete(change.tableId);
        columnMaps.delete(change.tableId);
        break;
      case 'rename_table':
        mustGet(tables, change.tableId, 'table').name = change.to;
        break;
      default:
        applyColumnChange(columnsOf(mustGet(tables, change.tableId, 'table')), change);
    }
  }

  for (const [tableId, columns] of columnMaps) {
    const table = tables.get(tableId);
    if (table !== undefined) table.columns = [...columns.values()];
  }
  next.tables = [...tables.values()];
  return next;
}

function applyColumnChange(columns: Map<string, Column>, change: ColumnChange): void {
  switch (change.kind) {
    case 'add_column':
      columns.set(change.column.id, structuredClone(change.column));
      break;
    case 'drop_column':
      mustGet(columns, change.columnId, 'column');
      columns.delete(change.columnId);
      break;
    case 'rename_column':
      mustGet(columns, change.columnId, 'column').name = change.to;
      break;
    case 'change_type':
      mustGet(columns, change.columnId, 'column').type = structuredClone(change.to);
      break;
    case 'change_nullable':
      mustGet(columns, change.columnId, 'column').nullable = change.to;
      break;
    case 'add_constraint': {
      const column = mustGet(columns, change.columnId, 'column');
      if (!column.constraints.some((existing) => equal(existing, change.constraint))) {
        column.constraints.push(structuredClone(change.constraint));
      }
      break;
    }
    case 'drop_constraint': {
      const column = mustGet(columns, change.columnId, 'column');
      column.constraints = column.constraints.filter(
        (existing) => !equal(existing, change.constraint),
      );
      break;
    }
  }
}

function mustGet<T>(map: Map<string, T>, id: string, what: 'table' | 'column'): T {
  const value = map.get(id);
  if (value === undefined) {
    throw new Error(`apply: change targets missing ${what} id "${id}"`);
  }
  return value;
}
