import { introspect } from '../operations/introspect';
import type { Introspection } from '../operations/introspect';

/**
 * The one thing this adapter needs from a database driver. Structural, so `pg`,
 * PGlite and anything else with a `query` satisfy it without the engine taking a
 * dependency on any of them — which is also what lets the test suite run the real
 * read-plan-apply cycle against an in-process Postgres.
 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Read a schema out of `pg_catalog`.
 *
 * `information_schema` would be more portable but it can't give us oids, and oids
 * are the whole point: they are the stable identity that makes a rename in a live
 * database read as a rename rather than as a drop and a recreate. It also hides
 * `pg_get_constraintdef`, which is the only way to get a CHECK expression back.
 *
 * Only ordinary tables (`relkind = 'r'`) are read. Views, materialised views,
 * partitions and foreign tables are out of scope rather than half-supported.
 */
export async function readCatalog(db: Queryable, schemaName: string): Promise<Introspection> {
  const [columns, constraints, sizes] = await Promise.all([
    db.query(COLUMNS, [schemaName]),
    db.query(CONSTRAINTS, [schemaName]),
    db.query(SIZES, [schemaName]),
  ]);

  return introspect(
    columns.rows.map((r) => ({
      tableOid: String(r.tableOid),
      tableName: String(r.tableName),
      attnum: Number(r.attnum),
      name: String(r.name),
      notNull: Boolean(r.notNull),
      formattedType: String(r.formattedType),
      defaultExpr: r.defaultExpr == null ? null : String(r.defaultExpr),
    })),
    constraints.rows.map((r) => ({
      tableOid: String(r.tableOid),
      name: String(r.name),
      type: r.type as 'p' | 'u' | 'c' | 'f',
      columns: ((r.columns as number[] | null) ?? []).map(Number),
      refTableOid: r.refTableOid == null ? null : String(r.refTableOid),
      refColumns: r.refColumns == null ? null : (r.refColumns as number[]).map(Number),
      definition: String(r.definition),
    })),
    // `bigint` arrives as a string from most drivers, because in general it does
    // not fit a JS number. Table sizes and row estimates comfortably do.
    sizes.rows.map((r) => ({
      tableOid: String(r.tableOid),
      rows: Number(r.rows),
      bytes: Number(r.bytes),
    })),
  );
}

const COLUMNS = `
  SELECT c.oid::text                             AS "tableOid",
         c.relname                               AS "tableName",
         a.attnum                                AS "attnum",
         a.attname                               AS "name",
         a.attnotnull                            AS "notNull",
         format_type(a.atttypid, a.atttypmod)    AS "formattedType",
         pg_get_expr(d.adbin, d.adrelid)         AS "defaultExpr"
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
  WHERE c.relkind = 'r' AND n.nspname = $1
  ORDER BY c.relname, a.attnum
`;

const CONSTRAINTS = `
  SELECT con.conrelid::text              AS "tableOid",
         con.conname                     AS "name",
         con.contype::text               AS "type",
         con.conkey::int[]               AS "columns",
         NULLIF(con.confrelid, 0)::text  AS "refTableOid",
         con.confkey::int[]              AS "refColumns",
         pg_get_constraintdef(con.oid)   AS "definition"
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relkind = 'r' AND con.contype IN ('p', 'u', 'c', 'f')
  ORDER BY con.conname
`;

/**
 * `reltuples` is the planner's estimate, not a count. `SELECT count(*)` on a 5GB
 * table is exactly the kind of thing this tool exists to avoid, and the estimate
 * is plenty good enough to decide whether a lock matters. It is -1 until the table
 * has been analysed, which `introspect` clamps.
 */
const SIZES = `
  SELECT c.oid::text                         AS "tableOid",
         c.reltuples::bigint::text           AS "rows",
         pg_total_relation_size(c.oid)::text AS "bytes"
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname = $1
`;
