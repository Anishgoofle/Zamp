import { fingerprint, readCatalog } from '../src/engine/index';
import { withDatabase } from './_db';
import { postJson, requireString } from './_http';

export const config = { maxDuration: 30 };

/**
 * Read a live database into the schema model.
 *
 * `POST { connectionString?, schema? }` → `{ schema, stats, notes, fingerprint }`.
 *
 * The `fingerprint` is what `/api/apply` checks before it touches anything: if the
 * database moved between reading it and applying to it, the plan was computed
 * against a schema that no longer exists and applying it would be a guess.
 */
export default postJson(async (body) => {
  const schemaName = requireString(body, 'schema', 'public');

  return withDatabase(body, { schema: schemaName, lockMs: 3_000, statementMs: 20_000 }, async ({ db, source }) => {
    const result = await readCatalog(db, schemaName);
    return { ...result, source, fingerprint: fingerprint(result.schema) };
  });
});
