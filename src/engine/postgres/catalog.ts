import { introspect } from '../operations/introspect.js';
import type { Introspection } from '../operations/introspect.js';

/**
 * The one thing this adapter needs from a driver. Structural, so pg, PGlite and
 * anything else with a `query` satisfy it and the engine depends on none of them.
 * That's also what lets the tests run a real read-plan-apply cycle in-process.
 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Read a schema out of pg_catalog.
 *
 * information_schema is more portable but has no oids, and the oids are the
 * point: they're the stable identity that makes a rename in a live database read
 * as a rename instead of a drop and a recreate. information_schema also hides
 * pg_get_constraintdef, the only way to get a CHECK expression back.
 *
 * Only ordinary tables (relkind = 'r'). Views, matviews, partitions and foreign
 * tables are out of scope rather than half-supported.
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
    // Most drivers return bigint as a string, since in general it doesn't fit a
    // JS number. Table sizes and row estimates comfortably do.
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
 * reltuples is the planner's estimate, not a count. Running SELECT count(*) on a
 * 5GB table is the sort of thing this tool exists to avoid, and an estimate is
 * plenty for deciding whether a lock matters. It reads -1 until the table has
 * been analysed; `introspect` clamps that.
 */
const SIZES = `
  SELECT c.oid::text                         AS "tableOid",
         c.reltuples::bigint::text           AS "rows",
         pg_total_relation_size(c.oid)::text AS "bytes"
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname = $1
`;
