import { Client } from 'pg';
import { SEED } from '../dev-database.js';

/**
 * Put the demo schema into the database a deployment points at.
 *
 *   DATABASE_URL=postgres://... npm run seed
 *
 * `npm run dev` gets this for free from its in-process Postgres, but a fresh Neon
 * or Supabase database is empty, and an empty database makes for a demo where
 * "Read schema" works perfectly and shows nothing.
 *
 * Drops the three demo tables first, so it re-runs cleanly and is obviously not
 * something to point at data you care about. It refuses to touch a database
 * holding tables it doesn't recognise, so a mistyped URL can't cost you a schema.
 */
const DEMO_TABLES = ['order_tags', 'orders', 'customers'];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail('Set DATABASE_URL first:  DATABASE_URL=postgres://... npm run seed');
  }

  const client = new Client({
    connectionString,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    );
    const unexpected = rows.map((r) => r.tablename).filter((t) => !DEMO_TABLES.includes(t));
    if (unexpected.length > 0) {
      fail(
        `This database already has tables that aren't part of the demo: ${unexpected.join(', ')}.\n` +
          `Refusing to touch it. Point DATABASE_URL at an empty database.`,
      );
    }

    await client.query(`DROP TABLE IF EXISTS ${DEMO_TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
    await client.query(SEED);

    const { rows: counts } = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM orders');
    const host = new URL(connectionString).hostname;
    console.log(`Seeded ${host}: customers, orders (${counts[0]?.n} rows), order_tags.`);
    console.log('Open the app, click "Read schema", and it will be there.');
  } finally {
    await client.end();
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((e: Error) => fail(e.message));
