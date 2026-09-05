import type { Queryable } from './src/engine/index.js';

/**
 * A throwaway Postgres for `npm run dev`, so the app works the moment it opens
 * rather than asking for a connection string first. PGlite is Postgres compiled
 * to wasm, running inside the dev server: no container to start, nothing to
 * install past `npm install`.
 *
 * Lives and dies with the dev server. api/_db.ts picks it up off globalThis and
 * never imports it, so none of this reaches a deployed build.
 */
export async function startDevDatabase(): Promise<string> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec(SEED);

  const db: Queryable = {
    query: (sql, params) =>
      pg.query(sql, params as unknown[]) as Promise<{ rows: Record<string, unknown>[] }>,
  };
  (globalThis as { __devDatabase?: Queryable }).__devDatabase = db;

  const { rows } = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM orders');
  return `${rows[0]?.n ?? 0} rows in orders`;
}

/**
 * Small but shaped like something real: a foreign key, a composite key, a check,
 * a jsonb column the model doesn't spell out, and enough rows that a failing
 * constraint has something to fail on.
 *
 * Exported so scripts/seed.ts can put the same schema into a real database.
 */
export const SEED = `
  CREATE TABLE customers (
    id      integer PRIMARY KEY,
    email   text NOT NULL,
    country varchar(2)
  );

  CREATE TABLE orders (
    id          integer PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES customers (id),
    total_cents integer NOT NULL CHECK (total_cents >= 0),
    note        text,
    metadata    jsonb,
    placed_at   timestamp with time zone NOT NULL DEFAULT now()
  );

  CREATE TABLE order_tags (
    order_id integer NOT NULL REFERENCES orders (id),
    tag      text    NOT NULL,
    PRIMARY KEY (order_id, tag)
  );

  INSERT INTO customers (id, email, country)
  SELECT i, 'customer' || i || '@example.com', CASE WHEN i % 3 = 0 THEN NULL ELSE 'IN' END
  FROM generate_series(1, 200) AS i;

  INSERT INTO orders (id, customer_id, total_cents, note)
  SELECT i, ((i - 1) % 200) + 1, i * 137, CASE WHEN i % 5 = 0 THEN NULL ELSE 'note ' || i END
  FROM generate_series(1, 1000) AS i;

  INSERT INTO order_tags (order_id, tag)
  SELECT i, 'priority' FROM generate_series(1, 1000, 7) AS i;

  ANALYZE;
`;
