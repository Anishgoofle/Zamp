import { describe, expect, it } from 'vitest';
import { branch, diff } from '@engine';
import { column, schema, table } from './fixtures';

describe('branch', () => {
  it('produces a fully independent copy', () => {
    const original = schema(table('t', 't', column('c', 'c', { kind: 'int' })));
    const copy = branch(original);

    copy.tables[0].name = 'changed';
    copy.tables[0].columns[0].nullable = true;

    expect(original.tables[0].name).toBe('t');
    expect(original.tables[0].columns[0].nullable).toBe(false);
  });

  it('has no diff to its source', () => {
    const original = schema(
      table(
        't',
        't',
        column('c', 'c', { kind: 'varchar', length: 255 }, { constraints: [{ kind: 'unique' }] }),
      ),
    );
    expect(diff(original, branch(original))).toEqual([]);
  });
});
