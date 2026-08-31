/**
 * The schema model: plain JSON-serializable data, no methods, no live refs (see
 * ../../decisions.md). Operations are free functions elsewhere in this folder.
 */

/** A full database schema. This is the versioned artifact. */
export interface Schema {
  tables: Table[];
}

export interface Table {
  /** Stable, opaque, non-empty. Diff pairs tables by this, never by `name`. */
  id: string;
  name: string;
  columns: Column[];
}

export interface Column {
  /** Stable, opaque, non-empty. Unique within its table. */
  id: string;
  name: string;
  type: ColumnType;
  nullable: boolean;
  /** Order is not significant — diff compares these as a set. */
  constraints: ColumnConstraint[];
}

export type ColumnType =
  | { kind: 'int' }
  | { kind: 'bigint' }
  | { kind: 'text' }
  | { kind: 'varchar'; length: number }
  | { kind: 'boolean' }
  | { kind: 'timestamp'; withTimezone: boolean }
  | { kind: 'numeric'; precision: number; scale: number };

export type ColumnConstraint =
  | { kind: 'primary_key' }
  | { kind: 'unique' }
  | { kind: 'default'; expr: string }
  | { kind: 'check'; expr: string }
  /** Target held by id and resolved on demand — never a live pointer. */
  | { kind: 'foreign_key'; refTableId: string; refColumnId: string };
