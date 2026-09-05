import type { Column, ColumnType, Schema, Table } from '../model/types.js';
import type { TableStats } from './plan.js';

/**
 * The catalog rows `introspect` expects. An explicit interface rather than `any`
 * off the driver, so the mapping is testable without a database. The SQL that
 * produces them lives in postgres/catalog.ts.
 */
export interface CatalogColumn {
  tableOid: string;
  tableName: string;
  /** Postgres attribute number. Stable across renames; never reused within a table. */
  attnum: number;
  name: string;
  notNull: boolean;
  /** `format_type(atttypid, atttypmod)`, e.g. "character varying(200)". */
  formattedType: string;
  /** `pg_get_expr(adbin, adrelid)`, or null when the column has no default. */
  defaultExpr: string | null;
}

export interface CatalogConstraint {
  tableOid: string;
  name: string;
  /** `p` primary key, `u` unique, `c` check, `f` foreign key. */
  type: 'p' | 'u' | 'c' | 'f';
  /** Attribute numbers this constraint covers, in order. */
  columns: number[];
  /** For a foreign key: the referenced table's oid and attribute numbers. */
  refTableOid: string | null;
  refColumns: number[] | null;
  /** `pg_get_constraintdef`. The only place a CHECK expression is available. */
  definition: string;
}

export interface CatalogTableSize {
  tableOid: string;
  rows: number;
  bytes: number;
}

export interface Introspection {
  schema: Schema;
  /** Live table sizes keyed by table id, ready to hand to `plan`. */
  stats: Record<string, TableStats>;
  /**
   * Everything in the database this model doesn't represent. Nothing here is
   * silently discarded. An unmodelled type is kept verbatim; anything else, like
   * a multi-column unique key or a table-level check, is left alone on both sides
   * of a diff. Never dropped, but not managed either.
   */
  notes: string[];
}

/**
 * Build a `Schema` from Postgres catalog rows.
 *
 * Ids come from the catalog rather than from us: a table is its oid, a column is
 * oid.attnum. Both survive renames and repeated reads of the same database, which
 * is what makes a rename diff as a rename instead of a drop plus an add.
 *
 * Two different databases (staging against production) have unrelated oids, so
 * comparing those needs `detectRenames` first. See decisions.md.
 */
export function introspect(
  columns: readonly CatalogColumn[],
  constraints: readonly CatalogConstraint[],
  sizes: readonly CatalogTableSize[] = [],
): Introspection {
  const notes: string[] = [];
  const tables = new Map<string, Table>();
  const columnByAttnum = new Map<string, Map<number, Column>>();

  for (const row of columns) {
    const tableId = tableIdOf(row.tableOid);
    let table = tables.get(tableId);
    if (!table) {
      table = { id: tableId, name: row.tableName, columns: [] };
      tables.set(tableId, table);
      columnByAttnum.set(tableId, new Map());
    }
    const column: Column = {
      id: columnIdOf(row.tableOid, row.attnum),
      name: row.name,
      type: parseType(row.formattedType),
      nullable: !row.notNull,
      constraints: row.defaultExpr ? [{ kind: 'default', expr: row.defaultExpr }] : [],
    };
    table.columns.push(column);
    columnByAttnum.get(tableId)!.set(row.attnum, column);
  }

  for (const row of constraints) {
    const tableId = tableIdOf(row.tableOid);
    const table = tables.get(tableId);
    if (!table) continue; // constraint on a relation we didn't read (a partition, a view)

    const columnsOf = columnByAttnum.get(tableId)!;
    const target = (attnum: number): Column | undefined => columnsOf.get(attnum);

    if (row.type === 'p') {
      // A composite primary key becomes `primary_key` on each member column, and
      // `plan` collapses them back into one PRIMARY KEY (a, b).
      for (const attnum of row.columns) target(attnum)?.constraints.push({ kind: 'primary_key' });
      continue;
    }

    if (row.columns.length !== 1) {
      notes.push(
        `${table.name}: ${describeConstraintType(row.type)} "${row.name}" spans ` +
          `${row.columns.length} columns, which this model doesn't represent. It is left as it ` +
          `is — not managed, and not dropped.`,
      );
      continue;
    }

    const column = target(row.columns[0]!);
    if (!column) continue;

    if (row.type === 'u') {
      column.constraints.push({ kind: 'unique' });
    } else if (row.type === 'c') {
      const expr = checkExpression(row.definition);
      if (expr) column.constraints.push({ kind: 'check', expr });
      else notes.push(`${table.name}.${column.name}: could not read CHECK "${row.name}" (${row.definition}).`);
    } else if (row.refTableOid && row.refColumns?.length === 1) {
      column.constraints.push({
        kind: 'foreign_key',
        refTableId: tableIdOf(row.refTableOid),
        refColumnId: columnIdOf(row.refTableOid, row.refColumns[0]!),
      });
    }
  }

  const stats: Record<string, TableStats> = {};
  for (const size of sizes) {
    // reltuples is a planner estimate and is -1 on a table that has never been
    // analysed; clamp so a caller never formats "-1 rows".
    stats[tableIdOf(size.tableOid)] = { rows: Math.max(0, size.rows), bytes: size.bytes };
  }

  for (const note of unmodelledTypeNotes(tables.values())) notes.push(note);

  return { schema: { tables: [...tables.values()] }, stats, notes };
}

function tableIdOf(oid: string): string {
  return `t${oid}`;
}

function columnIdOf(oid: string, attnum: number): string {
  return `c${oid}.${attnum}`;
}

function describeConstraintType(type: CatalogConstraint['type']): string {
  return type === 'u' ? 'unique key' : type === 'f' ? 'foreign key' : 'check constraint';
}

/**
 * Map `format_type` output onto the model. Anything not spelled out becomes
 * `{ kind: 'other', sql }` and round-trips verbatim, so the column stays in the
 * schema and diffs correctly against itself rather than being dropped because
 * there's no case for jsonb.
 */
function parseType(formatted: string): ColumnType {
  const type = formatted.trim();
  switch (type) {
    case 'integer':
      return { kind: 'int' };
    case 'bigint':
      return { kind: 'bigint' };
    case 'text':
      return { kind: 'text' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'timestamp without time zone':
      return { kind: 'timestamp', withTimezone: false };
    case 'timestamp with time zone':
      return { kind: 'timestamp', withTimezone: true };
  }
  const varchar = /^character varying\((\d+)\)$/.exec(type);
  if (varchar) return { kind: 'varchar', length: Number(varchar[1]) };

  const numeric = /^numeric\((\d+),(\d+)\)$/.exec(type);
  if (numeric) return { kind: 'numeric', precision: Number(numeric[1]), scale: Number(numeric[2]) };

  return { kind: 'other', sql: type };
}

/**
 * pg_get_constraintdef returns `CHECK ((price > 0))`. Strip the keyword and the
 * layer of parens Postgres always adds, so it reads the way someone wrote it.
 */
function checkExpression(definition: string): string | null {
  const body = definition.trim().replace(/\s+NOT VALID$/i, '');
  const match = /^CHECK\s*\((.*)\)$/is.exec(body);
  return match ? stripOuterParens(match[1]!.trim()) : null;
}

/** `((price > 0))` becomes `price > 0`. Leaves `(a > 0) AND (b > 0)` alone. */
function stripOuterParens(expr: string): string {
  let out = expr;
  while (wrappedInOneGroup(out)) out = out.slice(1, -1).trim();
  return out;
}

/** True when the leading `(` is the one closed by the trailing `)`. */
function wrappedInOneGroup(expr: string): boolean {
  if (!expr.startsWith('(') || !expr.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') depth++;
    else if (expr[i] === ')' && --depth === 0) return i === expr.length - 1;
  }
  return false;
}

function unmodelledTypeNotes(tables: Iterable<Table>): string[] {
  const byType = new Map<string, string[]>();
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.type.kind !== 'other') continue;
      const where = byType.get(column.type.sql) ?? [];
      where.push(`${table.name}.${column.name}`);
      byType.set(column.type.sql, where);
    }
  }
  return [...byType].map(
    ([type, where]) =>
      `${type} is kept verbatim (${where.join(', ')}). Renames, drops and constraints on ` +
      `these columns work; changing the type itself does not.`,
  );
}
