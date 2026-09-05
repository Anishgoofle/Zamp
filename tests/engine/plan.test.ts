import { describe, expect, it } from 'vitest';
import { batches, diff, plan } from '@engine';
import type { PlanOptions, Schema, Step } from '@engine';
import { column, schema, table } from './fixtures';

/** Plan `before` to `after` by diffing them first: the documented entry path. */
function planned(before: Schema, after: Schema, options?: PlanOptions) {
  return plan(before, diff(before, after), options);
}

function statements(before: Schema, after: Schema, options?: PlanOptions): string[] {
  return planned(before, after, options).steps.map((s) => s.sql);
}

/** The property that matters on a big table: nothing holds it while scanning it. */
function blocking(steps: readonly Step[]): string[] {
  return steps.filter((s) => s.lock === 'blocking').map((s) => s.sql);
}

const users = (...extra: Parameters<typeof table>[2][]) =>
  schema(
    table(
      't_users',
      'users',
      column('c_id', 'id', { kind: 'int' }, { constraints: [{ kind: 'primary_key' }] }),
      ...extra,
    ),
  );

describe('plan', () => {
  describe('NOT NULL', () => {
    const before = users(column('c_email', 'email', { kind: 'text' }, { nullable: true }));
    const after = users(column('c_email', 'email', { kind: 'text' }, { nullable: false }));

    it('is a single blocking statement in the direct plan', () => {
      const direct = planned(before, after, { online: false });
      expect(statements(before, after, { online: false })).toEqual([
        'ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;',
      ]);
      expect(blocking(direct.steps)).toHaveLength(1);
    });

    it('becomes a staged CHECK that is validated without holding the table', () => {
      const online = planned(before, after);
      expect(statements(before, after)).toEqual([
        'ALTER TABLE "users" ADD CONSTRAINT "users_email_not_null" CHECK ("email" IS NOT NULL) NOT VALID;',
        'ALTER TABLE "users" VALIDATE CONSTRAINT "users_email_not_null";',
        'ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;',
        'ALTER TABLE "users" DROP CONSTRAINT "users_email_not_null";',
      ]);
      expect(blocking(online.steps)).toEqual([]);
      // The scan happens, but under a lock that lets reads and writes through.
      expect(online.steps.filter((s) => s.scans).map((s) => s.lock)).toEqual(['concurrent']);
    });

    it('leaves DROP NOT NULL alone — it never touches a row either way', () => {
      expect(statements(after, before)).toEqual([
        'ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;',
      ]);
      expect(blocking(planned(after, before).steps)).toEqual([]);
    });
  });

  describe('constraints on a table that already has rows', () => {
    const plain = users(column('c_email', 'email'));

    it('adds a CHECK as NOT VALID and validates it separately', () => {
      const after = users(
        column('c_email', 'email', { kind: 'text' }, {
          constraints: [{ kind: 'check', expr: "email <> ''" }],
        }),
      );
      expect(statements(plain, after)).toEqual([
        `ALTER TABLE "users" ADD CONSTRAINT "users_email_check" CHECK (email <> '') NOT VALID;`,
        'ALTER TABLE "users" VALIDATE CONSTRAINT "users_email_check";',
      ]);
      expect(blocking(planned(plain, after).steps)).toEqual([]);
    });

    it('builds a unique index concurrently, then adopts it', () => {
      const after = users(
        column('c_email', 'email', { kind: 'text' }, { constraints: [{ kind: 'unique' }] }),
      );
      expect(statements(plain, after)).toEqual([
        'CREATE UNIQUE INDEX CONCURRENTLY "users_email_key" ON "users" ("email");',
        'ALTER TABLE "users" ADD CONSTRAINT "users_email_key" UNIQUE USING INDEX "users_email_key";',
      ]);
      expect(blocking(planned(plain, after).steps)).toEqual([]);
    });

    it('adds a foreign key NOT VALID — it locks two tables, not one', () => {
      const before = schema(
        table('t_users', 'users', column('c_id', 'id', { kind: 'int' })),
        table('t_posts', 'posts', column('c_author', 'author_id', { kind: 'int' })),
      );
      const after = schema(
        table('t_users', 'users', column('c_id', 'id', { kind: 'int' })),
        table(
          't_posts',
          'posts',
          column('c_author', 'author_id', { kind: 'int' }, {
            constraints: [{ kind: 'foreign_key', refTableId: 't_users', refColumnId: 'c_id' }],
          }),
        ),
      );
      expect(statements(before, after)).toEqual([
        'ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_fkey" ' +
          'FOREIGN KEY ("author_id") REFERENCES "users" ("id") NOT VALID;',
        'ALTER TABLE "posts" VALIDATE CONSTRAINT "posts_author_id_fkey";',
      ]);
    });

    it('adds constraints on a brand-new table outright — there is nothing to validate', () => {
      const before = schema();
      const after = schema(
        table(
          't_tags',
          'tags',
          column('c_label', 'label', { kind: 'text' }, { constraints: [{ kind: 'unique' }] }),
        ),
      );
      // No CONCURRENTLY, no NOT VALID. The table is empty and serves no traffic.
      expect(statements(before, after).every((s) => !s.includes('CONCURRENTLY'))).toBe(true);
      expect(blocking(planned(before, after).steps)).toEqual([]);
    });
  });

  describe('type changes', () => {
    const widen = (from: Parameters<typeof column>[2], to: Parameters<typeof column>[2]) =>
      planned(users(column('c_v', 'v', from)), users(column('c_v', 'v', to)));

    it('treats a varchar widening as free — Postgres does not re-check the rows', () => {
      const p = widen({ kind: 'varchar', length: 100 }, { kind: 'varchar', length: 200 });
      expect(p.steps[0]!.lock).toBe('instant');
      expect(p.steps[0]!.rewrites).toBe(false);
      expect(p.hazards).toEqual([]);
    });

    it('treats dropping the length limit as free', () => {
      expect(widen({ kind: 'varchar', length: 100 }, { kind: 'text' }).steps[0]!.lock).toBe('instant');
    });

    it('flags a varchar narrowing — every value has to be re-checked', () => {
      const p = widen({ kind: 'varchar', length: 200 }, { kind: 'varchar', length: 100 });
      expect(p.steps[0]!.lock).toBe('blocking');
      expect(p.steps[0]!.rewrites).toBe(true);
    });

    it('flags int → bigint, which looks harmless and rewrites the whole heap', () => {
      const p = widen({ kind: 'int' }, { kind: 'bigint' });
      expect(p.steps[0]!.rewrites).toBe(true);
      expect(p.hazards[0]!.message).toContain('shadow column');
    });

    it('has no online form to offer — the hazard stands in both plans', () => {
      const online = widen({ kind: 'int' }, { kind: 'bigint' });
      expect(online.steps).toHaveLength(1);
      expect(blocking(online.steps)).toHaveLength(1);
    });

    it('quotes the column in the USING clause', () => {
      const p = widen({ kind: 'int' }, { kind: 'bigint' });
      expect(p.steps[0]!.sql).toBe(
        'ALTER TABLE "users" ALTER COLUMN "v" TYPE bigint USING "v"::bigint;',
      );
    });
  });

  describe('ADD COLUMN', () => {
    const before = users();

    it('refuses NOT NULL with no default rather than emitting SQL that will fail', () => {
      const after = users(column('c_n', 'n', { kind: 'int' }));
      const p = planned(before, after);
      expect(p.hazards.map((h) => h.severity)).toContain('blocked');
      expect(p.hazards[0]!.message).toContain('NOT NULL with no default');
    });

    it('allows NOT NULL with a constant default — Postgres stores it in the catalog', () => {
      const after = users(
        column('c_n', 'n', { kind: 'int' }, { constraints: [{ kind: 'default', expr: '0' }] }),
      );
      const p = planned(before, after);
      expect(p.hazards).toEqual([]);
      expect(p.steps[0]!.rewrites).toBe(false);
      expect(p.steps[0]!.lock).toBe('instant');
    });

    it('flags a volatile default, which forces a rewrite', () => {
      const after = users(
        column('c_at', 'created_at', { kind: 'timestamp', withTimezone: true }, {
          constraints: [{ kind: 'default', expr: 'now()' }],
        }),
      );
      const p = planned(before, after);
      expect(p.steps[0]!.rewrites).toBe(true);
      expect(p.hazards[0]!.message).toContain('volatile');
    });
  });

  describe('primary keys', () => {
    it('builds the index concurrently on a table that already exists', () => {
      const before = schema(table('t_x', 'x', column('c_k', 'k', { kind: 'int' })));
      const after = schema(
        table(
          't_x',
          'x',
          column('c_k', 'k', { kind: 'int' }, { constraints: [{ kind: 'primary_key' }] }),
        ),
      );
      expect(statements(before, after)).toEqual([
        'CREATE UNIQUE INDEX CONCURRENTLY "x_pkey" ON "x" ("k");',
        'ALTER TABLE "x" ADD CONSTRAINT "x_pkey" PRIMARY KEY USING INDEX "x_pkey";',
      ]);
    });

    it('warns when the key covers a nullable column — Postgres will scan to tighten it', () => {
      const before = schema(
        table('t_x', 'x', column('c_k', 'k', { kind: 'int' }, { nullable: true })),
      );
      const after = schema(
        table(
          't_x',
          'x',
          column('c_k', 'k', { kind: 'int' }, {
            nullable: true,
            constraints: [{ kind: 'primary_key' }],
          }),
        ),
      );
      expect(planned(before, after).hazards[0]!.message).toContain('nullable');
    });
  });

  describe('table sizes', () => {
    it('puts the real size in the hazard rather than saying "large"', () => {
      const before = users(column('c_v', 'v', { kind: 'int' }));
      const after = users(column('c_v', 'v', { kind: 'bigint' }));
      const p = planned(before, after, {
        stats: { t_users: { rows: 48_000_000, bytes: 5_583_457_484 } },
      });
      expect(p.hazards[0]!.message).toContain('5.2 GB');
      expect(p.hazards[0]!.message).toContain('48.0M rows');
    });

    it('says nothing about size when the database was never read', () => {
      const before = users(column('c_v', 'v', { kind: 'int' }));
      const after = users(column('c_v', 'v', { kind: 'bigint' }));
      expect(planned(before, after).hazards[0]!.message).not.toContain('(');
    });
  });

  describe('transaction batching', () => {
    it('splits at the statements Postgres will not run inside a transaction', () => {
      const before = users(column('c_email', 'email'));
      const after = users(
        column('c_email', 'email', { kind: 'text' }, { constraints: [{ kind: 'unique' }] }),
      );
      const grouped = batches(planned(before, after).steps);
      expect(grouped.map((b) => b.runsInTransaction)).toEqual([false, true]);
      expect(grouped[0]!.steps[0]!.sql).toContain('CONCURRENTLY');
    });

    it('keeps everything in one transaction when nothing needs to escape it', () => {
      const before = users();
      const after = users(
        column('c_a', 'a', { kind: 'int' }, { constraints: [{ kind: 'default', expr: '0' }] }),
        column('c_b', 'b', { kind: 'int' }, { constraints: [{ kind: 'default', expr: '0' }] }),
      );
      expect(batches(planned(before, after).steps)).toHaveLength(1);
    });

    it('warns that a plan with CONCURRENTLY in it is not all-or-nothing', () => {
      const before = users(column('c_email', 'email'));
      const after = users(
        column('c_email', 'email', { kind: 'text' }, { constraints: [{ kind: 'unique' }] }),
      );
      expect(planned(before, after).hazards.map((h) => h.message).join(' ')).toContain(
        'not all-or-nothing',
      );
    });
  });

  describe('destructive changes', () => {
    it('warns about a dropped column even though the statement itself is instant', () => {
      const before = users(column('c_v', 'v'));
      const after = users();
      const p = planned(before, after);
      expect(p.steps[0]!.lock).toBe('instant');
      expect(p.hazards[0]!.message).toContain('There is no undo');
    });

    it('warns about a dropped table and names its size', () => {
      const before = users();
      const after = schema();
      const p = planned(before, after, { stats: { t_users: { rows: 10, bytes: 5_368_709_120 } } });
      expect(p.hazards[0]!.message).toContain('5.0 GB');
    });
  });

  it('warns that the direct plan is only safe on an empty database', () => {
    const before = users(column('c_v', 'v', { kind: 'int' }, { nullable: true }));
    const after = users(column('c_v', 'v', { kind: 'int' }, { nullable: false }));
    expect(planned(before, after, { online: false }).hazards.map((h) => h.message).join(' ')).toContain(
      'empty database',
    );
  });
});
