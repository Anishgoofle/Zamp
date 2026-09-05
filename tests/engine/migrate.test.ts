import { describe, expect, it } from 'vitest';
import { diff, migrate } from '@engine';
import type { ColumnConstraint, Schema } from '@engine';
import { column, schema, table } from './fixtures';

/** Migrate `before` to `after` by diffing them first — the documented entry path. */
function sql(before: Schema, after: Schema): string[] {
  return migrate(before, diff(before, after));
}

describe('migrate', () => {
  it('emits nothing for an empty change list', () => {
    const s = schema(table('t', 't', column('c', 'c', { kind: 'int' })));
    expect(migrate(s, [])).toEqual([]);
  });

  describe('tables', () => {
    it('creates a table with columns and inline constraints, FK deferred', () => {
      const before = schema(table('t_users', 'users', column('c_id', 'id', { kind: 'int' })));
      const after = schema(
        table('t_users', 'users', column('c_id', 'id', { kind: 'int' })),
        table(
          't_posts',
          'posts',
          column('c_pid', 'id', { kind: 'bigint' }, { constraints: [{ kind: 'primary_key' }] }),
          column('c_author', 'author_id', { kind: 'int' }, {
            constraints: [{ kind: 'foreign_key', refTableId: 't_users', refColumnId: 'c_id' }],
          }),
        ),
      );
      expect(sql(before, after)).toEqual([
        'CREATE TABLE "posts" (\n' +
          '  "author_id" integer NOT NULL,\n' +
          '  "id" bigint NOT NULL,\n' +
          '  CONSTRAINT "posts_pkey" PRIMARY KEY ("id")\n' +
          ');',
        'ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_fkey" ' +
          'FOREIGN KEY ("author_id") REFERENCES "users" ("id");',
      ]);
    });

    it('drops a table', () => {
      const before = schema(table('t', 'widgets', column('c', 'c', { kind: 'int' })));
      expect(sql(before, schema())).toEqual(['DROP TABLE "widgets";']);
    });

    it('renames a table before touching its columns', () => {
      const before = schema(
        table('t', 'users', column('c', 'email', { kind: 'text' }, { nullable: true })),
      );
      const after = schema(
        table('t', 'accounts', column('c', 'email', { kind: 'text' }, { nullable: false })),
      );
      expect(sql(before, after)).toEqual([
        'ALTER TABLE "users" RENAME TO "accounts";',
        'ALTER TABLE "accounts" ALTER COLUMN "email" SET NOT NULL;',
      ]);
    });
  });

  describe('columns', () => {
    const base = schema(table('t', 't', column('c', 'name', { kind: 'text' })));

    it('adds a column', () => {
      const after = schema(
        table(
          't',
          't',
          column('c', 'name', { kind: 'text' }),
          column('c2', 'age', { kind: 'int' }, { nullable: true }),
        ),
      );
      expect(sql(base, after)).toEqual(['ALTER TABLE "t" ADD COLUMN "age" integer;']);
    });

    it('drops a column by its name, not its id', () => {
      const after = schema(table('t', 't'));
      expect(sql(base, after)).toEqual(['ALTER TABLE "t" DROP COLUMN "name";']);
    });

    it('renames a column, then later phases use the new name', () => {
      const after = schema(table('t', 't', column('c', 'full_name', { kind: 'varchar', length: 200 })));
      expect(sql(base, after)).toEqual([
        'ALTER TABLE "t" RENAME COLUMN "name" TO "full_name";',
        'ALTER TABLE "t" ALTER COLUMN "full_name" TYPE varchar(200) USING "full_name"::varchar(200);',
      ]);
    });

    it('emits a USING cast on a type change', () => {
      const after = schema(table('t', 't', column('c', 'name', { kind: 'numeric', precision: 12, scale: 4 })));
      expect(sql(base, after)).toEqual([
        'ALTER TABLE "t" ALTER COLUMN "name" TYPE numeric(12,4) USING "name"::numeric(12,4);',
      ]);
    });

    it('renames a column into a name freed by a drop in the same changeset', () => {
      const before = schema(
        table('t', 't', column('c1', 'name', { kind: 'text' }), column('c2', 'full_name', { kind: 'text' })),
      );
      const after = schema(table('t', 't', column('c1', 'full_name', { kind: 'text' })));
      // drop must precede the rename, or PG rejects "column full_name already exists"
      expect(sql(before, after)).toEqual([
        'ALTER TABLE "t" DROP COLUMN "full_name";',
        'ALTER TABLE "t" RENAME COLUMN "name" TO "full_name";',
      ]);
    });

    it('toggles nullability both ways', () => {
      const nullable = schema(table('t', 't', column('c', 'name', { kind: 'text' }, { nullable: true })));
      expect(sql(base, nullable)).toEqual(['ALTER TABLE "t" ALTER COLUMN "name" DROP NOT NULL;']);
      expect(sql(nullable, base)).toEqual(['ALTER TABLE "t" ALTER COLUMN "name" SET NOT NULL;']);
    });
  });

  describe('constraints', () => {
    const col = (constraints: ColumnConstraint[]) =>
      schema(table('t', 't', column('c', 'email', { kind: 'text' }, { constraints })));

    it('adds a unique constraint as a named ALTER', () => {
      expect(sql(col([]), col([{ kind: 'unique' }]))).toEqual([
        'ALTER TABLE "t" ADD CONSTRAINT "t_email_key" UNIQUE ("email");',
      ]);
    });

    it('drops a constraint by its generated name', () => {
      expect(sql(col([{ kind: 'primary_key' }]), col([]))).toEqual([
        'ALTER TABLE "t" DROP CONSTRAINT "t_pkey";',
      ]);
    });

    it('drops a constraint by its pre-rename name when the table is also renamed', () => {
      const before = schema(
        table('t', 'users', column('c', 'email', { kind: 'text' }, { constraints: [{ kind: 'unique' }] })),
      );
      const after = schema(table('t', 'accounts', column('c', 'email', { kind: 'text' })));
      // PG keeps the constraint name across RENAME, so the DROP must say "users_email_key"
      expect(sql(before, after)).toEqual([
        'ALTER TABLE "users" DROP CONSTRAINT "users_email_key";',
        'ALTER TABLE "users" RENAME TO "accounts";',
      ]);
    });

    it('treats a default as SET DEFAULT / DROP DEFAULT, not a named constraint', () => {
      expect(sql(col([]), col([{ kind: 'default', expr: 'now()' }]))).toEqual([
        'ALTER TABLE "t" ALTER COLUMN "email" SET DEFAULT now();',
      ]);
      expect(sql(col([{ kind: 'default', expr: 'now()' }]), col([]))).toEqual([
        'ALTER TABLE "t" ALTER COLUMN "email" DROP DEFAULT;',
      ]);
    });

    it('renders a check expression verbatim', () => {
      expect(sql(col([]), col([{ kind: 'check', expr: "email <> ''" }]))).toEqual([
        `ALTER TABLE "t" ADD CONSTRAINT "t_email_check" CHECK (email <> '');`,
      ]);
    });

    it('suffixes a repeated generated name, as Postgres does', () => {
      const after = col([
        { kind: 'check', expr: 'x > 0' },
        { kind: 'check', expr: 'x < 10' },
      ]);
      expect(sql(col([]), after).map((s) => s.match(/CONSTRAINT "([^"]+)"/)![1])).toEqual([
        't_email_check',
        't_email_check1',
      ]);
    });

    it('collapses a per-column primary key into one composite constraint', () => {
      const after = schema(
        table(
          't',
          'memberships',
          column('c1', 'user_id', { kind: 'int' }, { constraints: [{ kind: 'primary_key' }] }),
          column('c2', 'group_id', { kind: 'int' }, { constraints: [{ kind: 'primary_key' }] }),
        ),
      );
      expect(sql(schema(), after)).toEqual([
        'CREATE TABLE "memberships" (\n' +
          '  "user_id" integer NOT NULL,\n' +
          '  "group_id" integer NOT NULL,\n' +
          '  CONSTRAINT "memberships_pkey" PRIMARY KEY ("user_id", "group_id")\n' +
          ');',
      ]);
    });
  });

  describe('ordering', () => {
    it('runs drops before creates and defers every foreign key to the end', () => {
      const before = schema(
        table('t_a', 'a', column('c_a', 'id', { kind: 'int' })),
        table('t_old', 'old', column('c_o', 'id', { kind: 'int' })),
      );
      const after = schema(
        table('t_a', 'a', column('c_a', 'id', { kind: 'int' })),
        table(
          't_b',
          'b',
          column('c_b', 'id', { kind: 'int' }),
          column('c_ref', 'a_id', { kind: 'int' }, {
            constraints: [{ kind: 'foreign_key', refTableId: 't_a', refColumnId: 'c_a' }],
          }),
        ),
      );
      const out = sql(before, after);
      expect(out).toEqual([
        'DROP TABLE "old";',
        'CREATE TABLE "b" (\n  "id" integer NOT NULL,\n  "a_id" integer NOT NULL\n);',
        'ALTER TABLE "b" ADD CONSTRAINT "b_a_id_fkey" FOREIGN KEY ("a_id") REFERENCES "a" ("id");',
      ]);
    });

    it('sequences a rename chain so the target name is free first', () => {
      const before = schema(table('t1', 'a'), table('t2', 'b'));
      const after = schema(table('t1', 'b'), table('t2', 'c'));
      expect(sql(before, after)).toEqual([
        'ALTER TABLE "b" RENAME TO "c";',
        'ALTER TABLE "a" RENAME TO "b";',
      ]);
    });

    it('breaks a rename cycle with a temporary name', () => {
      const before = schema(table('t', 't', column('c1', 'a'), column('c2', 'b')));
      const after = schema(table('t', 't', column('c1', 'b'), column('c2', 'a')));
      expect(sql(before, after)).toEqual([
        'ALTER TABLE "t" RENAME COLUMN "a" TO "a__tmp";',
        'ALTER TABLE "t" RENAME COLUMN "b" TO "a";',
        'ALTER TABLE "t" RENAME COLUMN "a__tmp" TO "b";',
      ]);
    });

    it('drops tables in foreign-key order — a referencing table first', () => {
      const before = schema(
        table('t_users', 'users', column('c_uid', 'id', { kind: 'int' })),
        table(
          't_posts',
          'posts',
          column('c_author', 'author_id', { kind: 'int' }, {
            constraints: [{ kind: 'foreign_key', refTableId: 't_users', refColumnId: 'c_uid' }],
          }),
        ),
      );
      // t_users sorts before t_posts in the diff, but posts references users,
      // so posts must be dropped first.
      expect(sql(before, schema())).toEqual(['DROP TABLE "posts";', 'DROP TABLE "users";']);
    });

    it('is deterministic and independent of input array ordering', () => {
      const before = schema(
        table('t1', 'one', column('c1', 'a', { kind: 'int' }), column('c2', 'b', { kind: 'text' })),
        table('t2', 'two', column('c3', 'c', { kind: 'boolean' })),
      );
      const after = schema(
        table('t1', 'uno', column('c1', 'a', { kind: 'bigint' }), column('c2', 'b', { kind: 'text' })),
        table('t3', 'three', column('c4', 'd', { kind: 'int' })),
      );
      const shuffled: Schema = {
        tables: [...after.tables].reverse().map((t) => ({ ...t, columns: [...t.columns].reverse() })),
      };
      expect(sql(before, shuffled)).toEqual(sql(before, after));
    });
  });

  it('inherits apply-style validation of the change list', () => {
    const before = schema(table('t', 't'));
    expect(() =>
      migrate(before, [{ kind: 'rename_table', tableId: 'missing', from: 'x', to: 'y' }]),
    ).toThrow(/missing table id "missing"/);
  });
});
