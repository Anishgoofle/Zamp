import type { Change, ColumnConstraint, ColumnType, Conflict, Schema } from '@engine';

export interface NameLookup {
  table(tableId: string): string;
  column(tableId: string, columnId: string): string;
}

/**
 * id → name for display. Pass schemas newest-first: a renamed entity reads from
 * the newer one, a dropped entity survives only in the older.
 */
export function makeNames(...schemas: Array<Schema | null | undefined>): NameLookup {
  const tables = new Map<string, string>();
  const columns = new Map<string, Map<string, string>>();
  for (const schema of [...schemas].reverse()) {
    for (const table of schema?.tables ?? []) {
      tables.set(table.id, table.name);
      const cols = columns.get(table.id) ?? new Map<string, string>();
      for (const column of table.columns) cols.set(column.id, column.name);
      columns.set(table.id, cols);
    }
  }
  return {
    table: (id) => tables.get(id) ?? id,
    column: (tableId, columnId) => columns.get(tableId)?.get(columnId) ?? columnId,
  };
}

function typeLabel(type: ColumnType): string {
  switch (type.kind) {
    case 'varchar':
      return `varchar(${type.length})`;
    case 'numeric':
      return `numeric(${type.precision},${type.scale})`;
    case 'timestamp':
      return type.withTimezone ? 'timestamptz' : 'timestamp';
    case 'other':
      return type.sql;
    default:
      return type.kind;
  }
}

function constraintLabel(constraint: ColumnConstraint, names: NameLookup): string {
  switch (constraint.kind) {
    case 'primary_key':
      return 'primary key';
    case 'unique':
      return 'unique';
    case 'default':
      return `default ${constraint.expr}`;
    case 'check':
      return `check (${constraint.expr})`;
    case 'foreign_key': {
      const { refTableId, refColumnId } = constraint;
      return `foreign key → ${names.table(refTableId)}.${names.column(refTableId, refColumnId)}`;
    }
  }
}

/** Which way a change cuts, for colour-coding the list. */
export function changeSign(change: Change): 'add' | 'drop' | 'modify' {
  switch (change.kind) {
    case 'add_table':
    case 'add_column':
    case 'add_constraint':
      return 'add';
    case 'drop_table':
    case 'drop_column':
    case 'drop_constraint':
      return 'drop';
    default:
      return 'modify';
  }
}

/** One-line summary of a `Change`, e.g. `users.email: type text → varchar(200)`. */
export function describeChange(change: Change, names: NameLookup): string {
  const table = names.table(change.tableId);

  switch (change.kind) {
    case 'add_table':
      return `create table ${change.table.name}`;
    case 'drop_table':
      return `drop table ${change.table.name}`;
    case 'rename_table':
      return `rename table ${change.from} → ${change.to}`;
    case 'add_column':
      return `${table}: add column ${change.column.name} (${typeLabel(change.column.type)})`;
    case 'drop_column':
      return `${table}: drop column ${change.column.name}`;
    case 'rename_column':
      return `${table}: rename ${change.from} → ${change.to}`;
  }

  const col = `${table}.${names.column(change.tableId, change.columnId)}`;
  switch (change.kind) {
    case 'change_type':
      return `${col}: type ${typeLabel(change.from)} → ${typeLabel(change.to)}`;
    case 'change_nullable':
      return `${col}: ${change.to ? 'now nullable' : 'now NOT NULL'}`;
    case 'add_constraint':
      return `${col}: add ${constraintLabel(change.constraint, names)}`;
    case 'drop_constraint':
      return `${col}: drop ${constraintLabel(change.constraint, names)}`;
  }
}

const CONFLICT_BLURB: Record<Conflict['kind'], string> = {
  'add/add': 'both branches created this, differently',
  'update/update': 'both branches changed this to different values',
  'delete/update': 'one branch deleted this, the other changed it',
};

/** Where a conflict sits and what it disputes, plus a plain-English blurb. */
export function describeConflict(
  conflict: Conflict,
  names: NameLookup,
): { where: string; blurb: string } {
  const at = conflict.columnId
    ? `${names.table(conflict.tableId)}.${names.column(conflict.tableId, conflict.columnId)}`
    : names.table(conflict.tableId);
  return { where: `${at} (${conflict.aspect})`, blurb: CONFLICT_BLURB[conflict.kind] };
}
