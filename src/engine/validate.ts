import type { Schema } from './types';

export interface ValidationError {
  message: string;
  tableId?: string;
  columnId?: string;
}

/**
 * The explicit invariant pass the plain-data model can't enforce at
 * construction (see ../../decisions.md): unique table ids and names, unique
 * column ids and names per table, resolvable foreign keys. Returns every problem
 * found. Callers run this on import; `diff`/`apply` assume it has passed.
 */
export function validate(schema: Schema): ValidationError[] {
  const errors: ValidationError[] = [];
  const columnIdsByTable = new Map<string, Set<string>>();

  const seenTableIds = new Set<string>();
  const seenTableNames = new Set<string>();
  for (const table of schema.tables) {
    if (seenTableIds.has(table.id)) {
      errors.push({ message: `duplicate table id "${table.id}"`, tableId: table.id });
    }
    seenTableIds.add(table.id);

    if (seenTableNames.has(table.name)) {
      errors.push({ message: `duplicate table name "${table.name}"`, tableId: table.id });
    }
    seenTableNames.add(table.name);

    const seenColumnIds = new Set<string>();
    const seenColumnNames = new Set<string>();
    for (const column of table.columns) {
      if (seenColumnIds.has(column.id)) {
        errors.push({
          message: `duplicate column id "${column.id}" in table "${table.id}"`,
          tableId: table.id,
          columnId: column.id,
        });
      }
      seenColumnIds.add(column.id);

      if (seenColumnNames.has(column.name)) {
        errors.push({
          message: `duplicate column name "${column.name}" in table "${table.id}"`,
          tableId: table.id,
          columnId: column.id,
        });
      }
      seenColumnNames.add(column.name);
    }
    // Union, not overwrite: a duplicated table id shouldn't also trigger a
    // spurious "unknown column" error for FKs that point at it.
    const known = columnIdsByTable.get(table.id);
    if (known === undefined) {
      columnIdsByTable.set(table.id, seenColumnIds);
    } else {
      for (const columnId of seenColumnIds) known.add(columnId);
    }
  }

  for (const table of schema.tables) {
    for (const column of table.columns) {
      for (const constraint of column.constraints) {
        if (constraint.kind !== 'foreign_key') continue;

        const targetColumns = columnIdsByTable.get(constraint.refTableId);
        if (targetColumns === undefined) {
          errors.push({
            message: `foreign key on "${table.id}"."${column.id}" references unknown table "${constraint.refTableId}"`,
            tableId: table.id,
            columnId: column.id,
          });
        } else if (!targetColumns.has(constraint.refColumnId)) {
          errors.push({
            message: `foreign key on "${table.id}"."${column.id}" references unknown column "${constraint.refTableId}"."${constraint.refColumnId}"`,
            tableId: table.id,
            columnId: column.id,
          });
        }
      }
    }
  }

  return errors;
}
