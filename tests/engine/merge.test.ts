import { describe, expect, it } from 'vitest';
import { diff, merge, resolveMerge } from '@engine';
import type { MergeResult } from '@engine';
import { column, schema, table } from './fixtures';

const base = schema(
  table(
    't_users',
    'users',
    column('c_id', 'id', { kind: 'int' }),
    column('c_email', 'email', { kind: 'text' }),
  ),
  table('t_posts', 'posts', column('c_title', 'title', { kind: 'text' })),
);

/** Apply a mutation to a deep clone of `base`. */
function edit(mutate: (s: typeof base) => void): typeof base {
  const next = structuredClone(base);
  mutate(next);
  return next;
}

const clean = (result: MergeResult) => {
  expect(result.conflicts).toEqual([]);
  expect(result.errors).toEqual([]);
};

describe('merge', () => {
  describe('clean', () => {
    it('base against itself is a no-op', () => {
      const result = merge(base, structuredClone(base), structuredClone(base));
      clean(result);
      expect(result.schema).toEqual(base);
    });

    it('takes ours when theirs is unchanged', () => {
      const ours = edit((s) => {
        s.tables[0].columns[1].nullable = true;
      });
      const result = merge(base, ours, structuredClone(base));
      clean(result);
      expect(result.schema).toEqual(ours);
    });

    it('takes theirs when ours is unchanged', () => {
      const theirs = edit((s) => s.tables.push(table('t_tags', 'tags')));
      const result = merge(base, structuredClone(base), theirs);
      clean(result);
      expect(result.schema).toEqual(theirs);
    });

    it('applies an identical change from both sides once', () => {
      const both = edit((s) => s.tables[0].columns[0].type = { kind: 'bigint' });
      const result = merge(base, structuredClone(both), structuredClone(both));
      clean(result);
      expect(result.schema).toEqual(both);
    });

    it('merges changes to different tables', () => {
      const ours = edit((s) => s.tables.push(table('t_a', 'a')));
      const theirs = edit((s) => s.tables.push(table('t_b', 'b')));
      const result = merge(base, ours, theirs);
      clean(result);
      expect(result.schema.tables.map((t) => t.id).sort()).toEqual([
        't_a',
        't_b',
        't_posts',
        't_users',
      ]);
    });

    it('merges changes to different fields of the same column', () => {
      const ours = edit((s) => s.tables[0].columns[1].type = { kind: 'varchar', length: 320 });
      const theirs = edit((s) => (s.tables[0].columns[1].nullable = true));
      const result = merge(base, ours, theirs);
      clean(result);
      const email = result.schema.tables[0].columns[1];
      expect(email.type).toEqual({ kind: 'varchar', length: 320 });
      expect(email.nullable).toBe(true);
    });

    it('merges two different check constraints on the same column', () => {
      const ours = edit((s) =>
        s.tables[0].columns[1].constraints.push({ kind: 'check', expr: "email <> ''" }),
      );
      const theirs = edit((s) =>
        s.tables[0].columns[1].constraints.push({ kind: 'check', expr: 'length(email) < 320' }),
      );
      const result = merge(base, ours, theirs);
      clean(result);
      expect(result.schema.tables[0].columns[1].constraints).toHaveLength(2);
    });

    it('does not conflict when both sides drop the same table', () => {
      const drop = edit((s) => (s.tables = s.tables.filter((t) => t.id !== 't_posts')));
      const result = merge(base, structuredClone(drop), structuredClone(drop));
      clean(result);
      expect(result.schema.tables.map((t) => t.id)).toEqual(['t_users']);
    });
  });

  describe('update/update', () => {
    it('flags a column changed to different types', () => {
      const ours = edit((s) => (s.tables[0].columns[0].type = { kind: 'bigint' }));
      const theirs = edit((s) => (s.tables[0].columns[0].type = { kind: 'text' }));
      const result = merge(base, ours, theirs);

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]).toMatchObject({
        kind: 'update/update',
        tableId: 't_users',
        columnId: 'c_id',
        aspect: 'type',
      });
      // conflicted location stays at base
      expect(result.schema.tables[0].columns[0].type).toEqual({ kind: 'int' });
    });

    it('flags a table renamed two ways', () => {
      const ours = edit((s) => (s.tables[1].name = 'articles'));
      const theirs = edit((s) => (s.tables[1].name = 'entries'));
      const result = merge(base, ours, theirs);
      expect(result.conflicts).toMatchObject([
        { kind: 'update/update', tableId: 't_posts', aspect: 'name' },
      ]);
    });

    it('flags conflicting defaults as one constraint conflict, not two independent adds', () => {
      const ours = edit((s) =>
        s.tables[0].columns[0].constraints.push({ kind: 'default', expr: '0' }),
      );
      const theirs = edit((s) =>
        s.tables[0].columns[0].constraints.push({ kind: 'default', expr: '1' }),
      );
      const result = merge(base, ours, theirs);
      expect(result.conflicts).toMatchObject([
        { kind: 'update/update', columnId: 'c_id', aspect: 'constraint:default' },
      ]);
      expect(result.schema.tables[0].columns[0].constraints).toEqual([]);
    });

    it('leaves the non-conflicting field of a partly-conflicting column merged', () => {
      const ours = edit((s) => {
        s.tables[0].columns[1].type = { kind: 'varchar', length: 100 };
        s.tables[0].columns[1].nullable = true;
      });
      const theirs = edit((s) => (s.tables[0].columns[1].type = { kind: 'varchar', length: 200 }));
      const result = merge(base, ours, theirs);

      expect(result.conflicts).toMatchObject([{ aspect: 'type', columnId: 'c_email' }]);
      expect(result.schema.tables[0].columns[1].nullable).toBe(true); // ours' nullable still merged
      expect(result.schema.tables[0].columns[1].type).toEqual({ kind: 'text' }); // type held at base
    });
  });

  describe('add/add', () => {
    it('flags the same new table id with different definitions', () => {
      const ours = edit((s) => s.tables.push(table('t_tags', 'tags', column('c_x', 'x', { kind: 'int' }))));
      const theirs = edit((s) => s.tables.push(table('t_tags', 'tags', column('c_x', 'x', { kind: 'text' }))));
      const result = merge(base, ours, theirs);

      expect(result.conflicts).toMatchObject([
        { kind: 'add/add', tableId: 't_tags', aspect: 'existence' },
      ]);
      expect(result.schema.tables.map((t) => t.id)).not.toContain('t_tags');
    });

    it('does not flag the same new table added identically by both', () => {
      const addition = edit((s) => s.tables.push(table('t_tags', 'tags', column('c_x', 'x', { kind: 'int' }))));
      const result = merge(base, structuredClone(addition), structuredClone(addition));
      clean(result);
      expect(result.schema.tables.map((t) => t.id)).toContain('t_tags');
    });
  });

  describe('delete/update', () => {
    it('flags ours dropping a table theirs modifies', () => {
      const ours = edit((s) => (s.tables = s.tables.filter((t) => t.id !== 't_posts')));
      const theirs = edit((s) => (s.tables[1].columns.push(column('c_body', 'body', { kind: 'text' }))));
      const result = merge(base, ours, theirs);

      expect(result.conflicts).toMatchObject([
        { kind: 'delete/update', tableId: 't_posts', aspect: 'existence' },
      ]);
      expect(result.conflicts[0].ours[0].kind).toBe('drop_table');
      expect(result.conflicts[0].theirs[0].kind).toBe('add_column');
      expect(result.schema.tables.map((t) => t.id)).toContain('t_posts'); // held at base
    });

    it('flags theirs dropping a column ours retypes', () => {
      const ours = edit((s) => (s.tables[0].columns[1].type = { kind: 'varchar', length: 320 }));
      const theirs = edit((s) => (s.tables[0].columns = s.tables[0].columns.filter((c) => c.id !== 'c_email')));
      const result = merge(base, ours, theirs);

      expect(result.conflicts).toMatchObject([
        { kind: 'delete/update', tableId: 't_users', columnId: 'c_email', aspect: 'existence' },
      ]);
    });

    it('flags ours dropping a table theirs only drops a column from', () => {
      const ours = edit((s) => (s.tables = s.tables.filter((t) => t.id !== 't_users')));
      const theirs = edit((s) => (s.tables[0].columns = s.tables[0].columns.filter((c) => c.id !== 'c_email')));
      const result = merge(base, ours, theirs);
      expect(result.conflicts).toMatchObject([{ kind: 'delete/update', tableId: 't_users' }]);
    });
  });

  describe('cross-entity (errors, not conflicts)', () => {
    it('surfaces an FK to a table the other side dropped', () => {
      const ours = edit((s) =>
        s.tables[1].columns[0].constraints.push({
          kind: 'foreign_key',
          refTableId: 't_users',
          refColumnId: 'c_id',
        }),
      );
      const theirs = edit((s) => (s.tables = s.tables.filter((t) => t.id !== 't_users')));
      const result = merge(base, ours, theirs);

      expect(result.conflicts).toEqual([]);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toMatch(/unknown table "t_users"/);
    });

    it('surfaces a name collision from two independent renames', () => {
      const ours = edit((s) => (s.tables[0].columns[0].name = 'ident'));
      const theirs = edit((s) => (s.tables[0].columns[1].name = 'ident'));
      const result = merge(base, ours, theirs);

      expect(result.conflicts).toEqual([]); // different columns, different slots
      expect(result.errors.map((e) => e.message)).toContain(
        'duplicate column name "ident" in table "t_users"',
      );
    });
  });

  describe('symmetry', () => {
    it('produces the same merged schema regardless of side order', () => {
      const ours = edit((s) => {
        s.tables[0].columns[1].nullable = true;
        s.tables.push(table('t_a', 'a'));
      });
      const theirs = edit((s) => (s.tables[0].columns[0].type = { kind: 'bigint' }));
      expect(merge(base, ours, theirs).schema).toEqual(merge(base, theirs, ours).schema);
    });
  });

  describe('resolveMerge', () => {
    const ours = edit((s) => (s.tables[0].columns[0].type = { kind: 'bigint' }));
    const theirs = edit((s) => (s.tables[0].columns[0].type = { kind: 'text' }));

    it('takes ours', () => {
      const result = merge(base, ours, theirs);
      const { schema, errors } = resolveMerge(result, { [result.conflicts[0].id]: 'ours' });
      expect(schema.tables[0].columns[0].type).toEqual({ kind: 'bigint' });
      expect(errors).toEqual([]);
      expect(diff(schema, ours)).toEqual([]);
    });

    it('takes theirs', () => {
      const result = merge(base, ours, theirs);
      const { schema } = resolveMerge(result, { [result.conflicts[0].id]: 'theirs' });
      expect(schema.tables[0].columns[0].type).toEqual({ kind: 'text' });
    });

    it('resolves a delete/update either way', () => {
      const dropper = edit((s) => (s.tables = s.tables.filter((t) => t.id !== 't_posts')));
      const modifier = edit((s) => s.tables[1].columns.push(column('c_body', 'body', { kind: 'text' })));
      const result = merge(base, dropper, modifier);
      const id = result.conflicts[0].id;

      expect(resolveMerge(result, { [id]: 'ours' }).schema.tables.map((t) => t.id)).not.toContain('t_posts');
      expect(
        resolveMerge(result, { [id]: 'theirs' }).schema.tables.find((t) => t.id === 't_posts')?.columns,
      ).toHaveLength(2);
    });

    it('reports errors when a resolution creates an invalid schema', () => {
      // ours renames c_id -> shared; theirs renames c_email -> shared (auto-merged).
      // resolving the ours side then collides two column names.
      const oursRename = edit((s) => (s.tables[0].columns[0].name = 'shared'));
      const theirsRename = edit((s) => (s.tables[0].columns[1].name = 'shared'));
      // force a conflict on c_id's name so there is something to resolve
      const theirsAlso = structuredClone(theirsRename);
      theirsAlso.tables[0].columns[0].name = 'other';
      const result = merge(base, oursRename, theirsAlso);
      const conflict = result.conflicts.find((c) => c.columnId === 'c_id' && c.aspect === 'name');
      const { errors } = resolveMerge(result, { [conflict!.id]: 'ours' });
      expect(errors.map((e) => e.message)).toContain('duplicate column name "shared" in table "t_users"');
    });

    it('throws when a conflict has no pick', () => {
      const result = merge(base, ours, theirs);
      expect(() => resolveMerge(result, {})).toThrow(/no pick for conflict/);
    });
  });
});
