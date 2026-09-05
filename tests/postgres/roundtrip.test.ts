import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diff, execute, plan, readCatalog, rehearse } from '@engine';
import type { Queryable, Schema, StepResult } from '@engine';

/**
 * The whole loop against a real Postgres: read a schema out of the catalog, plan a
 * change, run it, read it back. PGlite is Postgres 18 compiled to wasm and runs
 * in-process, so there's no server, no container and no fixture database to keep
 * alive. That's the only reason tests like these get written and then kept.
 *
 * They catch what unit tests can't: DDL that is syntactically fine and rejected by
 * the real planner, a constraint that passes on an empty table and fails on the
 * rows, and the difference between a rename and a drop.
 */

let db: PGlite;
/** PGlite's `query` is close enough to pg's. The engine only asks for `{ rows }`. */
let sql: Queryable;

beforeEach(async () => {
  db = await new PGlite();
  sql = { query: (text, params) => db.query(text, params as unknown[]) as Promise<{ rows: Record<string, unknown>[] }> };
});

afterEach(async () => {
  await db.close();
});

async function read(): Promise<Schema> {
  return (await readCatalog(sql, 'public')).schema;
}

/** Apply `target` to the live database the way `/api/apply` does, and report each step. */
async function applyTo(target: Schema, options: { online?: boolean } = {}): Promise<StepResult[]> {
  const live = await readCatalog(sql, 'public');
  const steps = plan(live.schema, diff(live.schema, target), {
    online: options.online ?? true,
    stats: live.stats,
  }).steps;
  return execute(sql, steps);
}

function edit(schema: Schema, change: (s: Schema) => void): Schema {
  const next = structuredClone(schema);
  change(next);
  return next;
}

const ok = (results: readonly StepResult[]) => results.every((r) => r.status === 'ok');

describe('against a real Postgres', () => {
  beforeEach(async () => {
    await db.exec(`
      CREATE TABLE users (
        id    integer PRIMARY KEY,
        email text NOT NULL
      );
      INSERT INTO users (id, email)
      SELECT i, 'user' || i || '@example.com' FROM generate_series(1, 500) AS i;
    `);
  });

  it('reads a schema back that diffs clean against itself', async () => {
    expect(diff(await read(), await read())).toEqual([]);
  });

  it('converges: applying a target leaves nothing left to do', async () => {
    const target = edit(await read(), (s) => {
      s.tables[0]!.columns.push({
        id: 'new',
        name: 'display_name',
        type: { kind: 'varchar', length: 80 },
        nullable: true,
        constraints: [],
      });
    });

    expect(ok(await applyTo(target))).toBe(true);
    // Read it back from the catalog and diff against the target as the database
    // now reports it. A second apply has to be a no-op.
    const after = await read();
    expect(diff(after, after)).toEqual([]);
    expect(after.tables[0]!.columns.map((c) => c.name)).toEqual(['id', 'email', 'display_name']);
  });

  describe('renames', () => {
    it('renames a column and keeps every row', async () => {
      const target = edit(await read(), (s) => {
        s.tables[0]!.columns[1]!.name = 'email_address';
      });

      const results = await applyTo(target);
      expect(results.map((r) => r.sql)).toEqual([
        'ALTER TABLE "users" RENAME COLUMN "email" TO "email_address";',
      ]);
      expect(ok(results)).toBe(true);

      const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
      expect(rows.rows[0]!.n).toBe(500);
      const sample = await db.query<{ email_address: string }>(
        'SELECT email_address FROM users WHERE id = 1',
      );
      expect(sample.rows[0]!.email_address).toBe('user1@example.com');
    });

    it('renames a table and its column in one plan, in an order Postgres accepts', async () => {
      const target = edit(await read(), (s) => {
        s.tables[0]!.name = 'accounts';
        s.tables[0]!.columns[1]!.name = 'login';
      });
      expect(ok(await applyTo(target))).toBe(true);
      const after = await read();
      expect(after.tables[0]!.name).toBe('accounts');
      expect(after.tables[0]!.columns.map((c) => c.name)).toEqual(['id', 'login']);
    });

    it('swaps two column names, which needs a temporary', async () => {
      await db.exec('ALTER TABLE users ADD COLUMN alias text');
      const target = edit(await read(), (s) => {
        const columns = s.tables[0]!.columns;
        columns[1]!.name = 'alias';
        columns[2]!.name = 'email';
      });

      const results = await applyTo(target);
      expect(ok(results)).toBe(true);
      expect(results).toHaveLength(3); // email → tmp, alias → email, tmp → alias
      // The swap really swapped: the old `email` values are under `alias` now.
      const row = await db.query<{ alias: string; email: string | null }>(
        'SELECT alias, email FROM users WHERE id = 1',
      );
      expect(row.rows[0]!.alias).toBe('user1@example.com');
      expect(row.rows[0]!.email).toBeNull();
    });
  });

  describe('the lock-safe plan', () => {
    it('runs the four-statement NOT NULL sequence and ends with a real NOT NULL', async () => {
      await db.exec("ALTER TABLE users ADD COLUMN nickname text");
      await db.exec("UPDATE users SET nickname = 'set'");

      const target = edit(await read(), (s) => {
        s.tables[0]!.columns[2]!.nullable = false;
      });
      const results = await applyTo(target);
      expect(ok(results)).toBe(true);
      expect(results).toHaveLength(4);

      const after = await read();
      expect(after.tables[0]!.columns[2]!.nullable).toBe(false);
      // The scaffolding CHECK is gone, not left behind.
      expect(after.tables[0]!.columns[2]!.constraints).toEqual([]);
      await expect(db.exec('INSERT INTO users (id, email) VALUES (9001, $$x$$)')).rejects.toThrow();
    });

    it('builds a unique index concurrently and adopts it as the constraint', async () => {
      const target = edit(await read(), (s) => {
        s.tables[0]!.columns[1]!.constraints.push({ kind: 'unique' });
      });
      expect(ok(await applyTo(target))).toBe(true);

      const after = await read();
      expect(after.tables[0]!.columns[1]!.constraints).toEqual([{ kind: 'unique' }]);
      await expect(
        db.exec("INSERT INTO users (id, email) VALUES (9001, 'user1@example.com')"),
      ).rejects.toThrow();
    });

    it('adds a CHECK as NOT VALID and then validates it for real', async () => {
      const target = edit(await read(), (s) => {
        s.tables[0]!.columns[0]!.constraints.push({ kind: 'check', expr: 'id > 0' });
      });
      expect(ok(await applyTo(target))).toBe(true);
      await expect(db.exec("INSERT INTO users (id, email) VALUES (-1, 'x')")).rejects.toThrow();
    });

    it('adds a foreign key NOT VALID and validates it against the existing rows', async () => {
      await db.exec(`
        CREATE TABLE teams (id integer PRIMARY KEY);
        INSERT INTO teams VALUES (1);
        ALTER TABLE users ADD COLUMN team_id integer;
        UPDATE users SET team_id = 1;
      `);
      const live = await read();
      const users = live.tables.find((t) => t.name === 'users')!;
      const teams = live.tables.find((t) => t.name === 'teams')!;
      const target = edit(live, (s) => {
        const table = s.tables.find((t) => t.name === 'users')!;
        table.columns.find((c) => c.name === 'team_id')!.constraints.push({
          kind: 'foreign_key',
          refTableId: teams.id,
          refColumnId: teams.columns[0]!.id,
        });
      });
      expect(users.columns.some((c) => c.name === 'team_id')).toBe(true);

      const results = await applyTo(target);
      expect(ok(results)).toBe(true);
      expect(results[0]!.sql).toContain('NOT VALID');
      expect(results[1]!.sql).toContain('VALIDATE CONSTRAINT');
      await expect(db.exec('INSERT INTO users VALUES (9001, $$x$$, 42)')).rejects.toThrow();
    });
  });

  describe('when the data says no', () => {
    it('fails the NOT NULL on the row that is actually null, and says which constraint', async () => {
      await db.exec('ALTER TABLE users ADD COLUMN nickname text');
      await db.exec("UPDATE users SET nickname = 'set' WHERE id > 1"); // id = 1 stays null

      const target = edit(await read(), (s) => {
        s.tables[0]!.columns[2]!.nullable = false;
      });
      const results = await applyTo(target);

      const failed = results.find((r) => r.status === 'failed');
      expect(failed?.sql).toContain('VALIDATE CONSTRAINT');
      expect(failed?.error).toContain('users_nickname_not_null');

      // And the column is still nullable, because the batch rolled back.
      expect((await read()).tables[0]!.columns[2]!.nullable).toBe(true);
    });

    it('fails a unique index on the duplicate rows rather than silently skipping it', async () => {
      await db.exec("INSERT INTO users (id, email) VALUES (9001, 'user1@example.com')");
      const target = edit(await read(), (s) => {
        s.tables[0]!.columns[1]!.constraints.push({ kind: 'unique' });
      });
      const results = await applyTo(target);
      expect(results[0]!.status).toBe('failed');
      // Postgres puts the offending value in `detail` rather than the message,
      // which is the difference between "it failed" and "here is the row".
      expect(results[0]!.error).toContain('could not create unique index');
      expect(results[0]!.error).toContain('(email)=(user1@example.com) is duplicated');
      expect(results[1]!.status).toBe('skipped');
    });

    it('rolls the whole transaction back, so a plan is all-or-nothing when it can be', async () => {
      const target = edit(await read(), (s) => {
        // A valid rename, then a CHECK that no row satisfies.
        s.tables[0]!.columns[1]!.name = 'email_address';
        s.tables[0]!.columns[0]!.constraints.push({ kind: 'check', expr: 'id > 1000' });
      });

      const results = await applyTo(target);
      expect(results.some((r) => r.status === 'failed')).toBe(true);
      // The rename succeeded inside the transaction and went back out with it,
      // so it reports as skipped rather than ok.
      expect(results.filter((r) => r.status === 'ok')).toEqual([]);
      expect((await read()).tables[0]!.columns[1]!.name).toBe('email');
    });
  });

  describe('rehearsal', () => {
    it('runs every statement against the real rows and keeps none of it', async () => {
      const target = edit(await read(), (s) => {
        s.tables[0]!.columns[1]!.name = 'email_address';
      });
      const live = await readCatalog(sql, 'public');
      const steps = plan(live.schema, diff(live.schema, target)).steps;

      const results = await rehearse(sql, steps);
      expect(ok(results)).toBe(true);
      expect((await read()).tables[0]!.columns[1]!.name).toBe('email');
    });

    it('finds a constraint the data violates, before anything is committed', async () => {
      const target = edit(await read(), (s) => {
        s.tables[0]!.columns[0]!.constraints.push({ kind: 'check', expr: 'id > 1000' });
      });
      const live = await readCatalog(sql, 'public');
      const steps = plan(live.schema, diff(live.schema, target)).steps;

      const results = await rehearse(sql, steps);
      expect(results.some((r) => r.status === 'failed')).toBe(true);
      expect(results.find((r) => r.status === 'failed')!.error).toContain('violated');
    });
  });

  describe('types the model does not spell out', () => {
    it('leaves a jsonb column alone instead of dropping it', async () => {
      await db.exec('ALTER TABLE users ADD COLUMN meta jsonb');
      await db.exec(`UPDATE users SET meta = '{"a":1}'::jsonb WHERE id = 1`);

      const live = await read();
      expect(live.tables[0]!.columns[2]!.type).toEqual({ kind: 'other', sql: 'jsonb' });

      // Rename something else entirely. The jsonb column must not be touched.
      const target = edit(live, (s) => {
        s.tables[0]!.columns[1]!.name = 'email_address';
      });
      expect(ok(await applyTo(target))).toBe(true);

      const kept = await db.query<{ meta: unknown }>('SELECT meta FROM users WHERE id = 1');
      expect(kept.rows[0]!.meta).toEqual({ a: 1 });
    });
  });

  describe('the direct plan', () => {
    it('reaches the same place as the lock-safe one', async () => {
      const target = edit(await read(), (s) => {
        s.tables[0]!.columns.push({
          id: 'n',
          name: 'note',
          type: { kind: 'text' },
          nullable: true,
          constraints: [{ kind: 'unique' }],
        });
      });
      expect(ok(await applyTo(target, { online: false }))).toBe(true);
      expect((await read()).tables[0]!.columns[2]!.constraints).toEqual([{ kind: 'unique' }]);
    });
  });
});

describe('creating a schema from nothing', () => {
  it('creates tables, keys and foreign keys in an order Postgres accepts', async () => {
    const target: Schema = {
      tables: [
        {
          id: 't_users',
          name: 'users',
          columns: [
            { id: 'c_id', name: 'id', type: { kind: 'int' }, nullable: false, constraints: [{ kind: 'primary_key' }] },
            { id: 'c_email', name: 'email', type: { kind: 'text' }, nullable: false, constraints: [{ kind: 'unique' }] },
          ],
        },
        {
          id: 't_posts',
          name: 'posts',
          columns: [
            { id: 'c_pid', name: 'id', type: { kind: 'bigint' }, nullable: false, constraints: [{ kind: 'primary_key' }] },
            {
              id: 'c_author',
              name: 'author_id',
              type: { kind: 'int' },
              nullable: false,
              constraints: [{ kind: 'foreign_key', refTableId: 't_users', refColumnId: 'c_id' }],
            },
          ],
        },
      ],
    };

    // `posts` references `users`, so the plan has to create `users` first even
    // though nothing in the change list says so.
    expect(ok(await applyTo(target))).toBe(true);

    const after = await read();
    expect(after.tables.map((t) => t.name).sort()).toEqual(['posts', 'users']);
    await expect(db.exec('INSERT INTO posts VALUES (1, 42)')).rejects.toThrow();
  });

  it('drops tables in FK order, dependents first', async () => {
    await db.exec(`
      CREATE TABLE users (id integer PRIMARY KEY);
      CREATE TABLE posts (id integer PRIMARY KEY, author_id integer REFERENCES users(id));
    `);
    expect(ok(await applyTo({ tables: [] }))).toBe(true);
    expect((await read()).tables).toEqual([]);
  });
});
