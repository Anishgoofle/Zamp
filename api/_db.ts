import { Client } from 'pg';
import type { Queryable } from '../src/engine/index.js';

/**
 * Serverless Postgres suspends when idle (Neon does it after five minutes) and the
 * connection that wakes it is slow. Against a cold Neon instance I saw two timeouts
 * then success, so one attempt isn't enough.
 *
 * Connections either land in about two seconds or hang forever, so waiting longer
 * on a stalled one never helped. Short timeout, spend the budget on more attempts.
 * The budget fits inside /api/introspect's 30s limit with room to answer.
 */
const CONNECT_TIMEOUT_MS = 5_000;
const CONNECT_BUDGET_MS = 22_000;
const RETRY_DELAY_MS = 300;

export interface SessionOptions {
  /** The Postgres schema every statement in this request applies to. */
  schema: string;
  /**
   * Hold an advisory lock for the whole request. Apply reads, plans against what
   * it read, then writes. A second apply landing in that gap passes the drift
   * check and then plans against a database that has already moved.
   */
  serialize?: boolean;

  /**
   * How long a statement waits for its lock before giving up. DDL that can't get
   * its lock queues behind the running query, and everything else queues behind
   * the DDL, so a three-second migration can take the table down for the length
   * of the longest open transaction. Fail fast and let the caller retry.
   */
  lockMs: number;
  statementMs: number;
}

/** A schema name Postgres will accept. */
const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

export interface Session {
  db: Queryable;
  /** What we connected to, for the UI. Never the connection string itself. */
  source: string;
}

/**
 * Resolve a database, run `body`, always clean up. A connection comes from one of
 * three places, in order:
 *
 * 1. The request body, only when ALLOW_CLIENT_DATABASE_URL=true. Off by default:
 *    an endpoint that dials whatever host a browser gives it is a port scanner
 *    with a public URL. The hosted demo turns it on so reviewers can point the
 *    tool at their own Postgres.
 * 2. DATABASE_URL, the database this deployment owns.
 * 3. The dev server's in-process Postgres, so `npm run dev` needs no setup. Never
 *    present in production.
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
  if (connectionString) requireSessionMode(connectionString);

  if (!connectionString) {
    const demo = devDatabase();
    if (!demo) {
      throw new HttpError(
        400,
        'No database configured. Set DATABASE_URL on the deployment, or send a connectionString ' +
          'with ALLOW_CLIENT_DATABASE_URL=true.',
      );
    }
    // One PGlite instance shared by every request, so two overlapping applies
    // would interleave their BEGIN and COMMIT. Queue them instead.
    return exclusively(async () => {
      await setSchema(demo, options.schema);
      return run({ db: demo, source: 'the dev server’s in-process database' });
    });
  }

  const client = await connect(connectionString);
  try {
    await client.query(`SET lock_timeout = ${Math.round(options.lockMs)}`);
    await client.query(`SET statement_timeout = ${Math.round(options.statementMs)}`);
    // Don't leave locks held if the function dies mid-transaction.
    await client.query('SET idle_in_transaction_session_timeout = 15000');
    await setSchema(client, options.schema);
    if (options.serialize) {
      // Session-scoped, so the `finally` below releases it even if we're killed
      // mid-request.
      await client.query('SELECT pg_advisory_lock($1)', [advisoryKey(options.schema)]);
    }
    return await run({ db: client, source: describe(connectionString) });
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Refuse a transaction-pooling endpoint.
 *
 * We keep state on the connection between round-trips: the two timeouts, the
 * search_path pin, and for apply a session advisory lock held from the read
 * through to the write. A transaction-mode pooler can hand each statement to a
 * different backend, which silently drops all three. Nothing errors; the
 * migration just stops being protected, so this is a refusal and not a warning.
 *
 * Providers name the pooled host differently. These are the common markers.
 */
const POOLED_HOST = /-pooler\.|^pgbouncer\.|\.pooler\./i;

function requireSessionMode(connectionString: string): void {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return; // not a URL we can inspect — let the driver report it
  }
  if (!POOLED_HOST.test(host)) return;

  throw new HttpError(
    400,
    `${host} is a connection pooler. This tool needs a direct connection: it holds a ` +
      `lock timeout, a pinned search_path and an advisory lock across several statements, ` +
      `and transaction pooling drops all three without saying so. Use the direct connection ` +
      `string instead — on Neon that is the same host with "-pooler" removed.`,
  );
}

/**
 * Generated DDL names tables unqualified, so it lands wherever search_path
 * resolves. Without this you can introspect `analytics` and alter `public`.
 * quote_ident runs server-side, so the name never reaches SQL as text.
 */
async function setSchema(db: Queryable, schema: string): Promise<void> {
  await db.query("SELECT set_config('search_path', quote_ident($1), false)", [schema]);
}

/** Stable lock key per schema. FNV-1a folded into a signed 32-bit int. */
function advisoryKey(schema: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < schema.length; i++) {
    hash ^= schema.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash | 0;
}

/** One shared dev connection, so callers take turns. */
let queue: Promise<unknown> = Promise.resolve();

function exclusively<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/**
 * A pg.Client that failed to connect can't be reused, so every attempt gets a new
 * one. Bounded by elapsed time rather than a retry count: a fast failure (bad
 * password) costs a few cheap retries, a slow one (waking compute) still gets
 * the full budget.
 */
async function connect(connectionString: string): Promise<Client> {
  const deadline = Date.now() + CONNECT_BUDGET_MS;
  let attempts = 0;
  let last: unknown;

  while (Date.now() < deadline) {
    attempts++;
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: Math.min(CONNECT_TIMEOUT_MS, deadline - Date.now()),
      ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : false,
      application_name: 'schema-version-control',
    });
    try {
      await client.connect();
      return client;
    } catch (e) {
      last = e;
      await client.end().catch(() => {});
      if (Date.now() + RETRY_DELAY_MS >= deadline) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  throw new HttpError(502, connectionFailure(last, connectionString, attempts));
}

/**
 * pg's connection-timeout error has an empty message, so the obvious version of
 * this reads "Could not connect: " and then stops. Name the host, the attempt
 * count, and the usual cause.
 */
function connectionFailure(cause: unknown, connectionString: string, attempts: number): string {
  const detail = message(cause).trim();
  return (
    `Could not connect to ${describe(connectionString)} after ${attempts} ` +
    `attempt${attempts === 1 ? '' : 's'}` +
    (detail ? `: ${detail}.` : '.') +
    ` A serverless database suspends when idle and can take a while to wake — ` +
    `if this is the first request in a while, try once more.`
  );
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
 * The dev server seeds a throwaway Postgres and parks it here. Read through a
 * global rather than an import so nothing in api/ depends on the dev database;
 * in production this is always undefined.
 */
function devDatabase(): Queryable | undefined {
  return (globalThis as { __devDatabase?: Queryable }).__devDatabase;
}

/**
 * Managed Postgres (Neon, Supabase, RDS) is TLS-only and usually presents a
 * certificate pg won't chain, so verification is off. Loopback doesn't need TLS.
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

/** `postgres://user:pw@host:5432/shop` becomes `shop on host`. No credentials. */
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
