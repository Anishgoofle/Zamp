import type { Schema } from '../model/types.js';

/** Index a list of id-bearing records by id. Last write wins on a duplicate. */
export function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return map;
}

/**
 * `diff` and `apply` pair tables and columns by id via `byId`, where a duplicate
 * id would shadow its twin and quietly give a wrong answer. Both call this first.
 * Full validation is `validate()`'s job; this is just their precondition.
 */
export function assertUniqueIds(schema: Schema, where: string): void {
  const tableIds = new Set<string>();
  for (const table of schema.tables) {
    if (tableIds.has(table.id)) {
      throw new Error(`${where}: duplicate table id "${table.id}"`);
    }
    tableIds.add(table.id);

    const columnIds = new Set<string>();
    for (const column of table.columns) {
      if (columnIds.has(column.id)) {
        throw new Error(`${where}: duplicate column id "${column.id}" in "${table.id}"`);
      }
      columnIds.add(column.id);
    }
  }
}
