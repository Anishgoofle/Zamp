import { describe, expect, it } from 'vitest';
import { detectRenames, diff } from '@engine';
import { column, schema, table } from './fixtures';

/** Re-id every table and column of `s` so nothing lines up with `before` by id. */
function reid(s: ReturnType<typeof schema>): ReturnType<typeof schema> {
  const next = structuredClone(s);
  for (const t of next.tables) {
    t.id = `x_${t.id}`;
    for (const c of t.columns) c.id = `x_${c.id}`;
  }
  return next;
}

describe('detectRenames', () => {
  it('matches a renamed column by structural signature so diff reports a rename', () => {
    const before = schema(
      table('t', 't', column('c_a', 'created', { kind: 'timestamp', withTimezone: true })),
    );
    const after = schema(
      table('t', 't', column('c_NEW', 'created_at', { kind: 'timestamp', withTimezone: true })),
    );

    const { schema: reconciled, matches } = detectRenames(before, after);
    expect(matches).toEqual([
      { scope: 'column', tableId: 't', keptId: 'c_a', incomingId: 'c_NEW', by: 'signature' },
    ]);
    expect(diff(before, reconciled)).toEqual([
      { kind: 'rename_column', tableId: 't', columnId: 'c_a', from: 'created', to: 'created_at' },
    ]);
  });

  it('matches a renamed table and reconciles its columns by name', () => {
    const before = schema(
      table('t_posts', 'posts', column('c_id', 'id', { kind: 'int' }), column('c_body', 'body')),
    );
    const after = schema(
      table('t_NEW', 'articles', column('c_1', 'id', { kind: 'int' }), column('c_2', 'body')),
    );

    const { schema: reconciled, matches } = detectRenames(before, after);
    expect(matches).toContainEqual({
      scope: 'table',
      keptId: 't_posts',
      incomingId: 't_NEW',
      by: 'signature',
    });
    expect(diff(before, reconciled)).toEqual([
      { kind: 'rename_table', tableId: 't_posts', from: 'posts', to: 'articles' },
    ]);
  });

  it('reconciles a fully re-id-ed but otherwise unchanged schema to an empty diff', () => {
    const before = schema(
      table('t_users', 'users', column('c_id', 'id', { kind: 'int' })),
      table('t_posts', 'posts', column('c_title', 'title')),
    );
    const after = reid(before); // identical names/types/structure, all ids regenerated

    const { schema: reconciled, matches } = detectRenames(before, after);
    expect(matches.every((m) => m.by === 'name')).toBe(true);
    expect(diff(before, reconciled)).toEqual([]);
  });

  it('matches a table renamed and a column within it renamed in the same step', () => {
    const before = schema(
      table(
        't_posts',
        'posts',
        column('c_id', 'id', { kind: 'int' }),
        column('c_body', 'body', { kind: 'text' }),
        column('c_author', 'author', { kind: 'text' }),
      ),
    );
    const after = schema(
      table(
        't_NEW',
        'articles',
        column('c_1', 'id', { kind: 'int' }),
        column('c_2', 'content', { kind: 'text' }), // body -> content
        column('c_3', 'author', { kind: 'text' }),
      ),
    );

    const { schema: reconciled } = detectRenames(before, after);
    expect(diff(before, reconciled)).toEqual([
      { kind: 'rename_table', tableId: 't_posts', from: 'posts', to: 'articles' },
      { kind: 'rename_column', tableId: 't_posts', columnId: 'c_body', from: 'body', to: 'content' },
    ]);
  });

  it('does not guess when two dropped columns share a signature with two added ones', () => {
    const before = schema(
      table('t', 't', column('c_a', 'a', { kind: 'int' }), column('c_b', 'b', { kind: 'int' })),
    );
    const after = schema(
      table('t', 't', column('c_x', 'x', { kind: 'int' }), column('c_y', 'y', { kind: 'int' })),
    );

    const { matches } = detectRenames(before, after);
    expect(matches).toEqual([]);
    // still a drop + add, not a rename
    expect(diff(before, detectRenames(before, after).schema).map((c) => c.kind).sort()).toEqual([
      'add_column',
      'add_column',
      'drop_column',
      'drop_column',
    ]);
  });

  it('aligns a retyped column by name and reports the type change, not a rename', () => {
    const before = schema(table('t', 't', column('c_a', 'amount', { kind: 'int' })));
    const after = schema(table('t', 't', column('c_NEW', 'amount', { kind: 'bigint' })));

    const { schema: reconciled, matches } = detectRenames(before, after);
    expect(matches).toEqual([
      { scope: 'column', tableId: 't', keptId: 'c_a', incomingId: 'c_NEW', by: 'name' },
    ]);
    expect(diff(before, reconciled)).toEqual([
      { kind: 'change_type', tableId: 't', columnId: 'c_a', from: { kind: 'int' }, to: { kind: 'bigint' } },
    ]);
  });

  it('matches an FK-bearing table across regenerated ids and remaps the reference', () => {
    const before = schema(
      table('t_users', 'users', column('c_uid', 'id', { kind: 'int' })),
      table(
        't_orders',
        'orders',
        column('c_oid', 'id', { kind: 'int' }),
        column('c_owner', 'user_id', { kind: 'int' }, {
          constraints: [{ kind: 'foreign_key', refTableId: 't_users', refColumnId: 'c_uid' }],
        }),
      ),
    );
    // parsed anew: all ids regenerated, orders -> purchases
    const after = schema(
      table('x_users', 'users', column('x_uid', 'id', { kind: 'int' })),
      table(
        'x_orders',
        'purchases',
        column('x_oid', 'id', { kind: 'int' }),
        column('x_owner', 'user_id', { kind: 'int' }, {
          constraints: [{ kind: 'foreign_key', refTableId: 'x_users', refColumnId: 'x_uid' }],
        }),
      ),
    );

    const { schema: reconciled } = detectRenames(before, after);
    expect(diff(before, reconciled)).toEqual([
      { kind: 'rename_table', tableId: 't_orders', from: 'orders', to: 'purchases' },
    ]);
  });

  it('does not match unrelated dropped and added tables', () => {
    const before = schema(table('t_a', 'a', column('c_1', 'foo', { kind: 'int' })));
    const after = schema(table('t_b', 'b', column('c_2', 'bar', { kind: 'text' })));

    expect(detectRenames(before, after).matches).toEqual([]);
  });

  it('leaves the input schemas untouched', () => {
    const before = schema(table('t', 't', column('c_a', 'a', { kind: 'int' })));
    const after = schema(table('t', 't', column('c_b', 'a', { kind: 'int' })));
    const afterCopy = structuredClone(after);

    detectRenames(before, after);
    expect(after).toEqual(afterCopy);
  });
});
