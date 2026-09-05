import { Client } from 'pg';
import type { Queryable } from '../src/engine/index';

/** How long one HTTP request is allowed to spend getting a connection. */
const CONNECT_TIMEOUT_MS = 8_000;

export interface SessionOptions {
  /** The Postgres schema every statement in this request applies to. */
  schema: string;
  /**
   * Hold an advisory lock for the whole request. Apply needs it: it reads the
   * schema, plans against what it read, and then writes — and without a lock a
   * second apply can land in that gap, so both callers pass the drift check and
   * the second one plans against a database that no longer exists.
   */
  serialize?: boolean;

  /**
   * How long a statement waits for its lock before giving up. Without this, DDL
   * that can't get its lock queues behind the running query — and every query
   * behind *it* — so a three-second migration takes the table down for as long as
   * the longest open transaction. Failing fast and retrying is the only safe way
   * to run DDL against a busy table.
   */
  lockMs: number;
  statementMs: number;
}

/** A schema name Postgres will accept; anything else is a typo or an attempt. */
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

export interface Session {
  db: Queryable;
  /** What we ended up talking to, for the UI to show. Never a connection string. */
  source: string;
}

/**
 * Resolve a database, run `body`, always clean up. Three places a connection can
 * come from, in order:
 *
 * 1. The request body — only when `ALLOW_CLIENT_DATABASE_URL=true`. Off by
 *    default, because an endpoint that dials whatever address a browser hands it
 *    is a port scanner with a public URL. The hosted demo turns it on
 *    deliberately: pointing the tool at your own Postgres is the only way to
 *    check that it really applies migrations.
 * 2. `DATABASE_URL` — the database this deployment owns.
 * 3. The dev server's throwaway in-process Postgres, so `npm run dev` works with
 *    nothing configured. It never exists in production.
 */
export async function withDatabase<T>(
  body: { connectionString?: unknown },
  options: SessionOptions,
  run: (session: Session) => Promise<T>,
): Promise<T> {
  if (!SCHEMA_NAME.test(options.schema)) {
    throw new HttpError(400, `"${options.schema.slice(0, 40)}" is not a usable schema name.`);
  }

  const connectionString = resolveConnectionString(body);

  if (!connectionString) {
    const demo = devDatabase();
    if (!demo) {
      throw new HttpError(
        400,
        'No database configured. Set DATABASE_URL on the deployment, or send a connectionString ' +
          'with ALLOW_CLIENT_DATABASE_URL=true.',
      );
    }
    // One PGlite instance, one connection, shared by every request in this dev
    // server — so two overlapping applies would interleave their BEGIN and COMMIT.
    // Queue them instead.
    return exclusively(async () => {
      await setSchema(demo, options.schema);
      return run({ db: demo, source: 'the dev server’s in-process database' });
    });
  }

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : false,
    application_name: 'schema-version-control',
  });
  try {
    await client.connect();
  } catch (e) {
    throw new HttpError(502, `Could not connect: ${message(e)}`);
  }
  try {
    await client.query(`SET lock_timeout = ${Math.round(options.lockMs)}`);
    await client.query(`SET statement_timeout = ${Math.round(options.statementMs)}`);
    // A function that dies mid-transaction shouldn't leave locks held until the
    // connection is reaped.
    await client.query('SET idle_in_transaction_session_timeout = 15000');
    await setSchema(client, options.schema);
    if (options.serialize) {
      // Session-scoped, so it is released when this connection closes in the
      // `finally` below — including when the function is killed mid-request.
      await client.query('SELECT pg_advisory_lock($1)', [advisoryKey(options.schema)]);
    }
    return await run({ db: client, source: describe(connectionString) });
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Every generated statement names a table without qualifying it, so what they
 * actually hit is whatever `search_path` resolves to. Reading `analytics` and
 * then altering `public` because the path said so is the kind of bug you find
 * afterwards. Pin the path to the schema the caller asked for; `quote_ident`
 * does the quoting on the server, so the name never reaches SQL as text.
 */
async function setSchema(db: Queryable, schema: string): Promise<void> {
  await db.query("SELECT set_config('search_path', quote_ident($1), false)", [schema]);
}

/** A stable advisory-lock key per schema. FNV-1a, folded into a signed 32-bit int. */
function advisoryKey(schema: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < schema.length; i++) {
    hash ^= schema.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash | 0;
}

/** Serialises callers into a single queue. One shared connection, one at a time. */
let queue: Promise<unknown> = Promise.resolve();

function exclusively<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

function resolveConnectionString(body: { connectionString?: unknown }): string | null {
  const fromClient = typeof body.connectionString === 'string' ? body.connectionString.trim() : '';
  if (fromClient) {
    if (process.env.ALLOW_CLIENT_DATABASE_URL !== 'true') {
      throw new HttpError(
        403,
        'This deployment only talks to its own database. Set ALLOW_CLIENT_DATABASE_URL=true to ' +
          'let the browser supply a connection string.',
      );
    }
    return fromClient;
  }
  return process.env.DATABASE_URL || null;
}

/**
 * The dev server seeds a throwaway Postgres and leaves it here. Reached through a
 * global rather than an import so nothing in `api/` depends on it — in production
 * this is always undefined and the code path is dead.
 */
function devDatabase(): Queryable | undefined {
  return (globalThis as { __devDatabase?: Queryable }).__devDatabase;
}

/**
 * Managed Postgres (Neon, Supabase, RDS, …) is TLS-only and usually presents a
 * certificate `pg` won't chain, so verification is off. Local development over a
 * loopback address doesn't need TLS at all.
 */
function needsSsl(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    if (url.searchParams.get('sslmode') === 'disable') return false;
    return !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return true;
  }
}

/** `postgres://user:pw@host:5432/shop` → `shop on host` — no credentials. */
function describe(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.pathname.replace(/^\//, '') || 'postgres'} on ${url.hostname}`;
  } catch {
    return 'the configured database';
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
