import { describe, expect, it } from 'vitest';
import { apply, diff } from '@engine';
import type { Change } from '@engine';
import { column, schema, table } from './fixtures';

describe('apply', () => {
  it('round-trips: applying diff(before, after) leaves no diff to after', () => {
    const before = schema(
      table(
        't_users',
        'users',
        column('c_id', 'id', { kind: 'int' }, { constraints: [{ kind: 'primary_key' }] }),
        column('c_email', 'email', { kind: 'text' }),
        column('c_temp', 'temp', { kind: 'text' }),
      ),
      table('t_legacy', 'legacy', column('c_x', 'x', { kind: 'int' })),
    );

    const after = schema(
      table(
        't_users',
        'accounts',
        column('c_id', 'id', { kind: 'bigint' }, { constraints: [{ kind: 'primary_key' }] }),
        column('c_email', 'email', { kind: 'text' }, {
          nullable: false,
          constraints: [{ kind: 'unique' }],
        }),
        column('c_created', 'created_at', { kind: 'timestamp', withTimezone: true }),
      ),
      table(
        't_events',
        'events',
        column('c_eid', 'id', { kind: 'bigint' }),
        column('c_uid', 'user_id', { kind: 'bigint' }, {
          constraints: [{ kind: 'foreign_key', refTableId: 't_users', refColumnId: 'c_id' }],
        }),
      ),
    );

    const result = apply(before, diff(before, after));
    expect(diff(result, after)).toEqual([]);
  });

  it('does not mutate its input', () => {
    const before = schema(table('t', 't', column('c', 'c', { kind: 'int' })));
    const snapshot = structuredClone(before);

    apply(before, [{ kind: 'rename_table', tableId: 't', from: 't', to: 'renamed' }]);

    expect(before).toEqual(snapshot);
  });

  it('is order-insensitive across independent changes', () => {
    const before = schema(table('t', 't', column('c', 'c', { kind: 'int' })));
    const forward: Change[] = [
      { kind: 'rename_column', tableId: 't', columnId: 'c', from: 'c', to: 'renamed' },
      { kind: 'change_type', tableId: 't', columnId: 'c', from: { kind: 'int' }, to: { kind: 'bigint' } },
      { kind: 'add_constraint', tableId: 't', columnId: 'c', constraint: { kind: 'unique' } },
    ];
    expect(apply(before, forward)).toEqual(apply(before, [...forward].reverse()));
  });

  it('applies many changes to one table via a single column map', () => {
    const before = schema(
      table(
        't',
        't',
        column('a', 'a', { kind: 'int' }),
        column('b', 'b', { kind: 'int' }),
        column('c', 'c', { kind: 'int' }),
      ),
    );
    const changes: Change[] = [
      { kind: 'rename_column', tableId: 't', columnId: 'a', from: 'a', to: 'a2' },
      { kind: 'change_type', tableId: 't', columnId: 'b', from: { kind: 'int' }, to: { kind: 'bigint' } },
      { kind: 'change_nullable', tableId: 't', columnId: 'c', from: false, to: true },
      { kind: 'drop_column', tableId: 't', columnId: 'c', column: column('c', 'c', { kind: 'int' }) },
      { kind: 'add_column', tableId: 't', columnId: 'd', column: column('d', 'd', { kind: 'text' }) },
    ];
    const result = apply(before, changes);
    expect(result.tables[0].columns.map((col) => col.id)).toEqual(['a', 'b', 'd']);
    expect(result.tables[0].columns[0].name).toBe('a2');
    expect(result.tables[0].columns[1].type).toEqual({ kind: 'bigint' });
  });

  it('throws when a change targets a missing id', () => {
    expect(() =>
      apply(schema(), [{ kind: 'rename_table', tableId: 'ghost', from: 'a', to: 'b' }]),
    ).toThrow(/missing table id/);
  });

  it('throws when a drop targets a missing id, rather than silently no-op', () => {
    const s = schema(table('t', 't'));
    expect(() =>
      apply(s, [{ kind: 'drop_column', tableId: 't', columnId: 'ghost', column: column('ghost', 'g') }]),
    ).toThrow(/missing column id/);
  });

  it('throws on duplicate ids in the input schema', () => {
    expect(() => apply(schema(table('t', 'a'), table('t', 'b')), [])).toThrow(
      /apply: duplicate table id "t"/,
    );
  });
});
