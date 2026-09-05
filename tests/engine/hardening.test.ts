import { describe, expect, it } from 'vitest';
import { diff, migrate, parseSchema } from '@engine';
import { column, schema, table } from './fixtures';

/** A minimal valid schema with one column carrying `constraints`. */
const withConstraints = (constraints: unknown[]) => ({
  tables: [
    {
      id: 't',
      name: 'orders',
      columns: [{ id: 'c', name: 'total', type: { kind: 'int' }, nullable: false, constraints }],
    },
  ],
});

const errorsFor = (value: unknown): string => (parseSchema(value).errors ?? []).join(' | ');

/**
 * `check` and `default` are the only two places a caller's own SQL text reaches
 * generated DDL. Every case here is an attempt to turn one expression into
 * something else. See src/engine/operations/sqlExpression.ts.
 */
describe('SQL expressions in constraints', () => {
  const rejects = (expr: string, because: string) =>
    it(`rejects ${because}`, () => {
      expect(errorsFor(withConstraints([{ kind: 'check', expr }]))).toContain('check');
      expect(parseSchema(withConstraints([{ kind: 'check', expr }])).schema).toBeNull();
    });

  rejects('total > 0); CREATE TABLE pwned (x int); --', 'a stacked statement');
  rejects('total > 0 --', 'a line comment');
  rejects('total > 0 /* hidden */', 'a block comment');
  rejects('total > 0 */', 'a stray comment terminator');
  rejects('total > 0)) OR (1=1', 'an expression that closes more parens than it opens');
  rejects('(total > 0', 'an expression that leaves a paren open');
  rejects("note <> 'unterminated", 'an unterminated string literal');
  rejects('$$anything$$ = $$anything$$', 'dollar quoting');
  rejects('total > 0 AND x = E\'\\\\x41\'', 'a backslash escape');
  rejects('', 'an empty expression');
  rejects('x'.repeat(1001), 'an expression past the length limit');

  it('accepts the expressions people actually write', () => {
    for (const expr of [
      'total > 0',
      "note <> ''",
      "country IN ('IN', 'US')",
      '(total > 0) AND (total < 1000000)',
      "status <> 'it''s fine'",
      'char_length(note) < 280',
    ]) {
      expect(parseSchema(withConstraints([{ kind: 'check', expr }])).errors, expr).toBeNull();
    }
  });

  it('applies the same gate to a default', () => {
    expect(errorsFor(withConstraints([{ kind: 'default', expr: '0; DROP TABLE orders; --' }])))
      .toContain('default');
    expect(parseSchema(withConstraints([{ kind: 'default', expr: 'now()' }])).errors).toBeNull();
  });
});

describe('identifiers', () => {
  const named = (name: string) => ({
    tables: [{ id: 't', name, columns: [{ id: 'c', name: 'c', type: { kind: 'int' }, nullable: true, constraints: [] }] }],
  });

  it('rejects a name Postgres would silently truncate', () => {
    expect(errorsFor(named('t'.repeat(64)))).toContain('silently truncate');
    expect(parseSchema(named('t'.repeat(63))).errors).toBeNull();
  });

  it('counts the limit in bytes, not characters', () => {
    // 32 three-byte characters is 96 bytes: under the character limit, over the byte one.
    expect(errorsFor(named('あ'.repeat(32)))).toContain('silently truncate');
  });

  it('rejects empty and padded names', () => {
    expect(errorsFor(named(''))).toContain('empty name');
    expect(errorsFor(named(' orders '))).toContain('whitespace');
  });

  /**
   * A double quote in an identifier is legal Postgres and turns up in real
   * databases, so it gets escaped rather than rejected. Rejecting it would mean
   * the tool couldn't read a schema that already contains one.
   */
  it('escapes a double quote instead of refusing the schema', () => {
    const before = schema(table('t', 'orders'));
    const after = schema(
      table('t', 'orders', column('c', 'a" ; DROP TABLE customers; --', { kind: 'int' }, { nullable: true })),
    );
    const statements = migrate(before, diff(before, after));
    expect(statements).toEqual([
      'ALTER TABLE "orders" ADD COLUMN "a"" ; DROP TABLE customers; --" integer;',
    ]);
    // One statement. The payload is inside the quoted identifier, not beside it.
    expect(statements[0]!.split(';').length).toBeGreaterThan(1); // it *contains* semicolons
    expect(statements).toHaveLength(1); // and is still a single statement
  });
});

describe('input size', () => {
  const many = (n: number) => ({
    tables: Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      name: `t${i}`,
      columns: [{ id: `c${i}`, name: 'c', type: { kind: 'int' }, nullable: true, constraints: [] }],
    })),
  });

  it('refuses a schema past the table limit rather than working on it for a minute', () => {
    expect(errorsFor(many(2001))).toContain('up to 2000');
    expect(parseSchema(many(2000)).errors).toBeNull();
  });

  it('refuses a column with an absurd number of constraints', () => {
    const constraints = Array.from({ length: 51 }, (_, i) => ({ kind: 'check', expr: `total > ${i}` }));
    expect(errorsFor(withConstraints(constraints))).toContain('the limit is 50');
  });
});

describe('unknown shapes', () => {
  it('rejects a type kind the model does not have, rather than rendering it as undefined', () => {
    expect(errorsFor({ tables: [{ id: 't', name: 'x', columns: [{ id: 'c', name: 'c', type: { kind: 'money' }, nullable: true, constraints: [] }] }] }))
      .toContain('Expected');
  });

  it('ignores an inherited property posing as a table list', () => {
    const polluted = JSON.parse('{"tables":[],"__proto__":{"tables":[{"id":"x"}]}}');
    expect(parseSchema(polluted).errors).toBeNull();
    expect(({} as Record<string, unknown>).tables).toBeUndefined();
  });
});
