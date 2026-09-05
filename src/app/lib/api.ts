import type { Plan, Schema, TableStats } from '@engine';

/** What `/api/introspect` gives back: a live database as a schema, plus its size. */
export interface LiveDatabase {
  schema: Schema;
  stats: Record<string, TableStats>;
  /** Things in the database the model doesn't manage — worth reading before you trust a diff. */
  notes: string[];
  /** Identity of `schema`; `/api/apply` refuses to run if the database has moved past it. */
  fingerprint: string;
  /** Which database answered, named without credentials — `shop on db.example.com`. */
  source: string;
}

export interface StepResult {
  sql: string;
  status: 'ok' | 'failed' | 'skipped';
  ms: number;
  error?: string;
}

export interface ApplyResponse {
  dryRun: boolean;
  online: boolean;
  /** Renames the server inferred because the target's ids didn't match the live database. */
  renames: Array<{ from: string; to: string; by: string }>;
  notes: string[];
  plan: Plan;
  results: StepResult[];
  applied: number;
  fingerprint: string;
  schema: Schema;
  stats: Record<string, TableStats>;
  source: string;
}

export interface Connection {
  connectionString: string;
  schema: string;
}

export function readDatabase(connection: Connection): Promise<LiveDatabase> {
  return post<LiveDatabase>('/api/introspect', connection);
}

export interface ApplyRequest extends Connection {
  target: Schema;
  online: boolean;
  dryRun: boolean;
  /** The fingerprint the plan was built against. */
  expect: string;
}

export function applySchema(request: ApplyRequest): Promise<ApplyResponse> {
  return post<ApplyResponse>('/api/apply', request);
}

async function post<T>(url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // A dev server without the api middleware, an offline browser, a blocked
    // request — all indistinguishable from here, so say what to check.
    throw new Error('Could not reach the server. Is it running?');
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(errorText(payload) ?? `Request failed (${response.status}).`);
  }
  return payload as T;
}

function errorText(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const { error } = payload as { error: unknown };
    if (typeof error === 'string') return error;
  }
  return null;
}
