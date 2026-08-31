import type { Column, ColumnConstraint, ColumnType, Table } from './types';

/**
 * The diff vocabulary: `diff` emits it, `apply` consumes it. Field-level, so a
 * type change and a nullability change on one column are separate entries and
 * don't conflict (see ../../decisions.md). Add/drop kinds carry the whole,
 * normalized object.
 */
export type Change =
  | { kind: 'add_table'; tableId: string; table: Table }
  | { kind: 'drop_table'; tableId: string; table: Table }
  | { kind: 'rename_table'; tableId: string; from: string; to: string }
  | { kind: 'add_column'; tableId: string; columnId: string; column: Column }
  | { kind: 'drop_column'; tableId: string; columnId: string; column: Column }
  | { kind: 'rename_column'; tableId: string; columnId: string; from: string; to: string }
  | { kind: 'change_type'; tableId: string; columnId: string; from: ColumnType; to: ColumnType }
  | { kind: 'change_nullable'; tableId: string; columnId: string; from: boolean; to: boolean }
  | { kind: 'add_constraint'; tableId: string; columnId: string; constraint: ColumnConstraint }
  | { kind: 'drop_constraint'; tableId: string; columnId: string; constraint: ColumnConstraint };

/** Changes scoped to a column (everything except the table-level kinds). */
export type ColumnChange = Exclude<
  Change,
  { kind: 'add_table' | 'drop_table' | 'rename_table' }
>;
