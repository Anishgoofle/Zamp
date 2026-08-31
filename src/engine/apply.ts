import { equal } from './canonical';
import type { Change, ColumnChange } from './change';
import { assertUniqueIds, byId } from './collections';
import type { Schema, Table } from './types';

/**
 * Apply a change list to a schema, returning a new schema; the input is not
 * mutated. `apply(s, diff(s, t))` has no remaining diff to `t`. Changes are
 * mutually independent, so order does not matter; new tables and columns are
 * appended (order is not significant, see ../../decisions.md).
 *
 * Throws on duplicate ids in `schema`, or on a change targeting an id that is
 * not present — both mean a malformed or stale input, not a recoverable state.
 */
export function apply(schema: Schema, changes: readonly Change[]): Schema {
  assertUniqueIds(schema, 'apply');

  const next = structuredClone(schema);
  const tables = byId(next.tables);

  for (const change of changes) {
    switch (change.kind) {
      case 'add_table':
        tables.set(change.table.id, structuredClone(change.table));
        break;
      case 'drop_table':
        mustGet(tables, change.tableId, 'table');
        tables.delete(change.tableId);
        break;
      case 'rename_table':
        mustGet(tables, change.tableId, 'table').name = change.to;
        break;
      default:
        applyColumnChange(mustGet(tables, change.tableId, 'table'), change);
    }
  }

  next.tables = [...tables.values()];
  return next;
}

function applyColumnChange(table: Table, change: ColumnChange): void {
  const columns = byId(table.columns);

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

  table.columns = [...columns.values()];
}

function mustGet<T>(map: Map<string, T>, id: string, what: 'table' | 'column'): T {
  const value = map.get(id);
  if (value === undefined) {
    throw new Error(`apply: change targets missing ${what} id "${id}"`);
  }
  return value;
}
