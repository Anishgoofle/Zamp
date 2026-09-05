import {
  detectRenames,
  diff,
  execute,
  fingerprint,
  parseSchema,
  plan,
  readCatalog,
  rehearse,
} from '../src/engine/index';
import type { Schema } from '../src/engine/index';
import { HttpError, withDatabase } from './_db';
import { postJson, requireString } from './_http';

export const config = { maxDuration: 60 };

/** Leave room to roll back and answer before the platform kills the function. */
const RESERVE_MS = 6_000;
const BUDGET_MS = config.maxDuration * 1000 - RESERVE_MS;

/** Don't queue behind a long-running query; fail fast and let the caller retry. */
const LOCK_TIMEOUT_MS = 3_000;

/**
 * Bring a live database in line with a target schema.
 *
 * `POST { connectionString?, schema?, target, online?, dryRun?, expect?, force? }`
 *
 * The browser sends the schema it wants, never the SQL. The server reads the live
 * database itself, diffs against *that*, and runs its own plan — so the only
 * statements that ever execute are ones this engine generated. An endpoint that
 * accepted SQL would be an open query console for every database this deployment
 * can reach.
 */
export default postJson(async (body) => {
  const schemaName = requireString(body, 'schema', 'public');
  const online = body.online !== false;
  const dryRun = body.dryRun !== false; // writing is opt-in
  const alignRenames = body.alignRenames !== false;

  const parsed = parseSchema(body.target);
  if (parsed.errors) {
    throw new HttpError(400, `Target schema is not usable: ${parsed.errors.join('; ')}`);
  }
  const target = parsed.schema;

  const deadline = Date.now() + BUDGET_MS;

  return withDatabase(body, { schema: schemaName, lockMs: LOCK_TIMEOUT_MS, statementMs: BUDGET_MS, serialize: true }, async ({ db, source }) => {
    const live = await readCatalog(db, schemaName);
    const liveFingerprint = fingerprint(live.schema);

    // The plan the caller reviewed was computed against a schema they read
    // earlier. If the database has moved since, that plan describes something
    // that no longer exists — refuse rather than apply it to whatever is there now.
    const expected = typeof body.expect === 'string' ? body.expect : null;
    if (expected && expected !== liveFingerprint) {
      throw new HttpError(
        409,
        `The database changed since you read it (expected ${expected}, found ${liveFingerprint}). ` +
          `Read it again and review the plan.`,
      );
    }

    const aligned = align(live.schema, target, alignRenames);
    const changes = diff(live.schema, aligned.target);
    const migration = plan(live.schema, changes, { online, stats: live.stats });

    const blocked = migration.hazards.filter((h) => h.severity === 'blocked');
    if (blocked.length > 0 && body.force !== true) {
      throw new HttpError(422, `Refusing to run: ${blocked.map((h) => h.message).join(' ')}`);
    }

    const results =
      changes.length === 0
        ? []
        : dryRun
          ? await rehearse(db, migration.steps, { deadline })
          : await execute(db, migration.steps, { deadline });

    // Report what the database actually looks like now, not what we hoped.
    const after = dryRun ? live : await readCatalog(db, schemaName);

    return {
      dryRun,
      source,
      online,
      renames: aligned.renames,
      notes: live.notes,
      plan: migration,
      results,
      applied: results.filter((r) => r.status === 'ok').length,
      fingerprint: fingerprint(after.schema),
      schema: after.schema,
      stats: after.stats,
    };
  });
});

/**
 * A target authored against a different database (or by hand) has ids that mean
 * nothing here, so every table would diff as a drop and an add — which on a live
 * database is every row in it. `detectRenames` re-pairs the two by name and by
 * structure first. It is a heuristic, so the matches it made come back in the
 * response to be looked at, rather than being applied quietly.
 */
function align(
  live: Schema,
  target: Schema,
  enabled: boolean,
): { target: Schema; renames: Array<{ from: string; to: string; by: string }> } {
  if (!enabled || sharesIds(live, target)) return { target, renames: [] };

  const { schema, matches } = detectRenames(live, target);
  const before = labels(live);
  const after = labels(schema);

  const renames: Array<{ from: string; to: string; by: string }> = [];
  for (const match of matches) {
    const from = before.get(match.keptId);
    const to = after.get(match.keptId);
    // A match that didn't change the name is an id being reconciled, not a rename.
    if (from && to && from !== to) renames.push({ from, to, by: match.by });
  }
  return { target: schema, renames };
}

/** id → a name a person can read, for both sides of a rename. */
function labels(schema: Schema): Map<string, string> {
  const out = new Map<string, string>();
  for (const table of schema.tables) {
    out.set(table.id, table.name);
    for (const column of table.columns) out.set(column.id, `${table.name}.${column.name}`);
  }
  return out;
}

function sharesIds(live: Schema, target: Schema): boolean {
  const ids = new Set(live.tables.map((t) => t.id));
  return target.tables.some((t) => ids.has(t.id));
}
