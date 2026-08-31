import type { Column, ColumnConstraint, ColumnType, Schema, Table } from '@engine';

/** Terse builders for schema fixtures. Everything is still plain data. */

export function schema(...tables: Table[]): Schema {
  return { tables };
}

export function table(id: string, name: string, ...columns: Column[]): Table {
  return { id, name, columns };
}

interface ColumnOptions {
  nullable?: boolean;
  constraints?: ColumnConstraint[];
}

export function column(
  id: string,
  name: string,
  type: ColumnType = { kind: 'text' },
  options: ColumnOptions = {},
): Column {
  return {
    id,
    name,
    type,
    nullable: options.nullable ?? false,
    constraints: options.constraints ?? [],
  };
}
