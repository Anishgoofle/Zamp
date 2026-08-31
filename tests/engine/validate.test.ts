import { describe, expect, it } from 'vitest';
import { validate } from '@engine';
import { column, schema, table } from './fixtures';

describe('validate', () => {
  it('accepts a well-formed schema', () => {
    const s = schema(
      table('t_users', 'users', column('c_id', 'id', { kind: 'int' })),
      table(
        't_posts',
        'posts',
        column('c_id', 'id', { kind: 'int' }),
        column('c_author', 'author', { kind: 'int' }, {
          constraints: [{ kind: 'foreign_key', refTableId: 't_users', refColumnId: 'c_id' }],
        }),
      ),
    );
    expect(validate(s)).toEqual([]);
  });

  it('flags duplicate table ids', () => {
    const s = schema(table('dup', 'a'), table('dup', 'b'));
    expect(validate(s)).toContainEqual(expect.objectContaining({ tableId: 'dup' }));
  });

  it('flags duplicate column ids within a table', () => {
    const s = schema(
      table('t', 't', column('c', 'a', { kind: 'int' }), column('c', 'b', { kind: 'int' })),
    );
    expect(validate(s)).toContainEqual(
      expect.objectContaining({ tableId: 't', columnId: 'c' }),
    );
  });

  it('flags a duplicate table name', () => {
    const s = schema(table('t_1', 'orders'), table('t_2', 'orders'));
    expect(validate(s).map((e) => e.message)).toContain('duplicate table name "orders"');
  });

  it('flags a duplicate column name within a table', () => {
    const s = schema(
      table('t', 't', column('c_1', 'total', { kind: 'int' }), column('c_2', 'total', { kind: 'int' })),
    );
    expect(validate(s)).toContainEqual(
      expect.objectContaining({ message: 'duplicate column name "total" in table "t"', columnId: 'c_2' }),
    );
  });

  it('allows the same column name in different tables', () => {
    const s = schema(
      table('t_a', 'a', column('c_a', 'id', { kind: 'int' })),
      table('t_b', 'b', column('c_b', 'id', { kind: 'int' })),
    );
    expect(validate(s)).toEqual([]);
  });

  it('flags a foreign key to an unknown table', () => {
    const s = schema(
      table('t', 't', column('c', 'c', { kind: 'int' }, {
        constraints: [{ kind: 'foreign_key', refTableId: 'ghost', refColumnId: 'x' }],
      })),
    );
    expect(validate(s).map((error) => error.message).join('\n')).toContain('unknown table');
  });

  it('does not add a spurious FK error when a table id is duplicated', () => {
    const s = schema(
      table('dup', 'a', column('x', 'x', { kind: 'int' })),
      table('dup', 'b', column('y', 'y', { kind: 'int' })),
      table('t_fk', 'fk', column('f', 'f', { kind: 'int' }, {
        constraints: [{ kind: 'foreign_key', refTableId: 'dup', refColumnId: 'x' }],
      })),
    );
    const messages = validate(s).map((error) => error.message);
    expect(messages.some((message) => message.includes('duplicate table id'))).toBe(true);
    expect(messages.some((message) => message.includes('unknown'))).toBe(false);
  });

  it('flags a foreign key to an unknown column', () => {
    const s = schema(
      table('t_a', 'a', column('c_a', 'a', { kind: 'int' })),
      table('t_b', 'b', column('c_b', 'b', { kind: 'int' }, {
        constraints: [{ kind: 'foreign_key', refTableId: 't_a', refColumnId: 'ghost' }],
      })),
    );
    expect(validate(s).map((error) => error.message).join('\n')).toContain('unknown column');
  });
});
