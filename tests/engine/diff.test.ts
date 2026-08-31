import { describe, expect, it } from 'vitest';
import { diff } from '@engine';
import type { Change, ColumnConstraint, ColumnType, Schema } from '@engine';
import { column, schema, table } from './fixtures';

describe('diff', () => {
  it('reports nothing for identical schemas', () => {
    const s = schema(
      table('t_users', 'users', column('c_id', 'id', { kind: 'int' })),
    );
    expect(diff(s, structuredClone(s))).toEqual([]);
  });

  describe('preconditions', () => {
    it('throws on a duplicate table id rather than silently shadowing one', () => {
      const dupTables = schema(table('t', 'a'), table('t', 'b'));
      expect(() => diff(dupTables, schema())).toThrow(/duplicate table id "t"/);
      expect(() => diff(schema(), dupTables)).toThrow(/diff \(after\)/);
    });

    it('throws on a duplicate column id', () => {
      const dupColumns = schema(
        table('t', 't', column('c', 'a', { kind: 'int' }), column('c', 'b', { kind: 'int' })),
      );
      expect(() => diff(dupColumns, dupColumns)).toThrow(/duplicate column id "c" in "t"/);
    });
  });

  describe('tables', () => {
    it('detects an added table and carries its full definition', () => {
      const users = table('t_users', 'users', column('c_id', 'id', { kind: 'int' }));
      expect(diff(schema(), schema(users))).toEqual<Change[]>([
        { kind: 'add_table', tableId: 't_users', table: users },
      ]);
    });

    it('detects a dropped table', () => {
      const users = table('t_users', 'users', column('c_id', 'id', { kind: 'int' }));
      expect(diff(schema(users), schema())).toEqual<Change[]>([
        { kind: 'drop_table', tableId: 't_users', table: users },
      ]);
    });

    it('detects a rename as same id, new name', () => {
      const before = schema(table('t', 'users'));
      const after = schema(table('t', 'accounts'));
      expect(diff(before, after)).toEqual<Change[]>([
        { kind: 'rename_table', tableId: 't', from: 'users', to: 'accounts' },
      ]);
    });
  });

  describe('columns', () => {
    const base = (col: ReturnType<typeof column>) => schema(table('t', 't', col));

    it('detects an added column', () => {
      const before = schema(table('t', 't'));
      const email = column('c_email', 'email', { kind: 'text' });
      expect(diff(before, base(email))).toEqual<Change[]>([
        { kind: 'add_column', tableId: 't', columnId: 'c_email', column: email },
      ]);
    });

    it('detects a dropped column', () => {
      const email = column('c_email', 'email', { kind: 'text' });
      expect(diff(base(email), schema(table('t', 't')))).toEqual<Change[]>([
        { kind: 'drop_column', tableId: 't', columnId: 'c_email', column: email },
      ]);
    });

    it('detects a rename', () => {
      expect(
        diff(base(column('c', 'email')), base(column('c', 'email_address'))),
      ).toEqual<Change[]>([
        { kind: 'rename_column', tableId: 't', columnId: 'c', from: 'email', to: 'email_address' },
      ]);
    });

    it('reports a type change as change_type, never drop + add', () => {
      expect(
        diff(base(column('c', 'amount', { kind: 'int' })), base(column('c', 'amount', { kind: 'bigint' }))),
      ).toEqual<Change[]>([
        {
          kind: 'change_type',
          tableId: 't',
          columnId: 'c',
          from: { kind: 'int' },
          to: { kind: 'bigint' },
        },
      ]);
    });

    it('reports a nullability flip', () => {
      expect(
        diff(
          base(column('c', 'note', { kind: 'text' }, { nullable: false })),
          base(column('c', 'note', { kind: 'text' }, { nullable: true })),
        ),
      ).toEqual<Change[]>([
        { kind: 'change_nullable', tableId: 't', columnId: 'c', from: false, to: true },
      ]);
    });
  });

  describe('constraints', () => {
    const withConstraints = (...constraints: ColumnConstraint[]) =>
      schema(table('t', 't', column('c', 'c', { kind: 'int' }, { constraints })));

    it('detects an added constraint', () => {
      expect(diff(withConstraints(), withConstraints({ kind: 'unique' }))).toEqual<Change[]>([
        { kind: 'add_constraint', tableId: 't', columnId: 'c', constraint: { kind: 'unique' } },
      ]);
    });

    it('detects a dropped constraint', () => {
      expect(diff(withConstraints({ kind: 'unique' }), withConstraints())).toEqual<Change[]>([
        { kind: 'drop_constraint', tableId: 't', columnId: 'c', constraint: { kind: 'unique' } },
      ]);
    });

    it('ignores constraint reordering', () => {
      const a = withConstraints({ kind: 'primary_key' }, { kind: 'unique' });
      const b = withConstraints({ kind: 'unique' }, { kind: 'primary_key' });
      expect(diff(a, b)).toEqual([]);
    });

    it('collapses a repeated identical constraint to a single change', () => {
      const before = withConstraints();
      const after = withConstraints({ kind: 'unique' }, { kind: 'unique' });
      expect(diff(before, after)).toEqual<Change[]>([
        { kind: 'add_constraint', tableId: 't', columnId: 'c', constraint: { kind: 'unique' } },
      ]);
    });
  });

  describe('granularity', () => {
    it('keeps a type change and a nullability change on different columns separate', () => {
      const before = schema(
        table(
          't',
          't',
          column('a', 'a', { kind: 'int' }),
          column('b', 'b', { kind: 'text' }, { nullable: false }),
        ),
      );
      const after = schema(
        table(
          't',
          't',
          column('a', 'a', { kind: 'bigint' }),
          column('b', 'b', { kind: 'text' }, { nullable: true }),
        ),
      );
      expect(diff(before, after)).toEqual<Change[]>([
        {
          kind: 'change_type',
          tableId: 't',
          columnId: 'a',
          from: { kind: 'int' },
          to: { kind: 'bigint' },
        },
        { kind: 'change_nullable', tableId: 't', columnId: 'b', from: false, to: true },
      ]);
    });
  });

  describe('determinism', () => {
    const shuffle = (s: Schema): Schema => ({
      tables: [...s.tables].reverse().map((t) => ({
        ...t,
        columns: [...t.columns].reverse().map((c) => ({
          ...c,
          constraints: [...c.constraints].reverse(),
        })),
      })),
    });

    it('is independent of table / column / constraint ordering in the input', () => {
      const before = schema(
        table(
          't1',
          'one',
          column('c1', 'c1', { kind: 'int' }, {
            constraints: [{ kind: 'primary_key' }, { kind: 'unique' }],
          }),
          column('c2', 'c2', { kind: 'text' }),
        ),
        table('t2', 'two', column('c3', 'c3', { kind: 'boolean' })),
      );
      const after = schema(
        table(
          't1',
          'uno',
          column('c1', 'c1', { kind: 'bigint' }, { constraints: [{ kind: 'unique' }] }),
          column('c2', 'c2', { kind: 'text' }),
        ),
        // added table with several columns: its embedded payload must also be
        // order-independent
        table(
          't3',
          'three',
          column('c_z', 'z', { kind: 'int' }),
          column('c_a', 'a', { kind: 'text' }, { constraints: [{ kind: 'unique' }, { kind: 'primary_key' }] }),
        ),
      );

      expect(diff(shuffle(before), shuffle(after))).toEqual(diff(before, after));
    });

    it('is byte-stable under object-key reordering inside a type', () => {
      const base = schema(table('t', 't'));
      const withA = schema(
        table('t', 't', column('c', 'c', { kind: 'numeric', precision: 10, scale: 2 })),
      );
      const withB = schema(
        table('t', 't', column('c', 'c', { scale: 2, precision: 10, kind: 'numeric' } as ColumnType)),
      );
      expect(JSON.stringify(diff(base, withA))).toBe(JSON.stringify(diff(base, withB)));
    });
  });
});
