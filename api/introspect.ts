import { fingerprint, readCatalog } from '../src/engine/index.js';
import { withDatabase } from './_db.js';
import { postJson, requireString } from './_http.js';

export const config = { maxDuration: 30 };

/**
 * Read a live database into the schema model.
 *
 * `POST { connectionString?, schema? }` returns `{ schema, stats, notes, fingerprint }`.
 *
 * /api/apply checks the fingerprint before it touches anything. If the database
 * moved between the read and the apply, the plan was built against a schema that
 * no longer exists, and running it would be a guess.
 */
export default postJson(async (body) => {
  const schemaName = requireString(body, 'schema', 'public');

  return withDatabase(body, { schema: schemaName, lockMs: 3_000, statementMs: 20_000 }, async ({ db, source }) => {
    const result = await readCatalog(db, schemaName);
    return { ...result, source, fingerprint: fingerprint(result.schema) };
  });
});
