import { describe, expect, it } from 'vitest';
import { detectRenames, diff, introspect, migrate } from '@engine';
import type { CatalogColumn, CatalogConstraint } from '@engine';

/**
 * Catalog rows exactly as postgres/catalog.ts reads them. Building them by hand
 * keeps the mapping testable without a database. The SQL behind them is three
 * plain SELECTs; the interesting part is what we do with the answers.
 */
function col(over: Partial<CatalogColumn> & Pick<CatalogColumn, 'attnum' | 'name'>): CatalogColumn {
  return {
    tableOid: '16400',
    tableName: 'users',
    notNull: true,
    formattedType: 'text',
    defaultExpr: null,
    ...over,
  };
}

function con(
  over: Partial<CatalogConstraint> & Pick<CatalogConstraint, 'type' | 'columns'>,
): CatalogConstraint {
  return {
    tableOid: '16400',
    name: 'c',
    refTableOid: null,
    refColumns: null,
    definition: '',
    ...over,
  };
}

describe('introspect', () => {
  it('takes its ids from the catalog, so they survive a rename', () => {
    const { schema } = introspect([col({ attnum: 1, name: 'id', formattedType: 'integer' })], []);
    expect(schema.tables[0]!.id).toBe('t16400');
    expect(schema.tables[0]!.columns[0]!.id).toBe('c16400.1');
  });

  describe('types', () => {
    const typeOf = (formattedType: string) =>
      introspect([col({ attnum: 1, name: 'v', formattedType })], []).schema.tables[0]!.columns[0]!
        .type;

    it('maps the types the model spells out', () => {
      expect(typeOf('integer')).toEqual({ kind: 'int' });
      expect(typeOf('bigint')).toEqual({ kind: 'bigint' });
      expect(typeOf('text')).toEqual({ kind: 'text' });
      expect(typeOf('boolean')).toEqual({ kind: 'boolean' });
      expect(typeOf('character varying(200)')).toEqual({ kind: 'varchar', length: 200 });
      expect(typeOf('numeric(10,2)')).toEqual({ kind: 'numeric', precision: 10, scale: 2 });
      expect(typeOf('timestamp with time zone')).toEqual({ kind: 'timestamp', withTimezone: true });
      expect(typeOf('timestamp without time zone')).toEqual({
        kind: 'timestamp',
        withTimezone: false,
      });
    });

    it('keeps a type it does not model rather than dropping the column', () => {
      expect(typeOf('jsonb')).toEqual({ kind: 'other', sql: 'jsonb' });
      expect(typeOf('uuid')).toEqual({ kind: 'other', sql: 'uuid' });
      expect(typeOf('text[]')).toEqual({ kind: 'other', sql: 'text[]' });
      // For a diff, an unbounded varchar is not the same as text, so it isn't one.
      expect(typeOf('character varying')).toEqual({ kind: 'other', sql: 'character varying' });
    });

    it('is a no-op to diff a jsonb column against itself', () => {
      const rows = [col({ attnum: 1, name: 'payload', formattedType: 'jsonb' })];
      const a = introspect(rows, []).schema;
      const b = introspect(rows, []).schema;
      expect(diff(a, b)).toEqual([]);
    });

    it('says which columns it is only holding, not managing', () => {
      const { notes } = introspect(
        [
          col({ attnum: 1, name: 'a', formattedType: 'jsonb' }),
          col({ attnum: 2, name: 'b', formattedType: 'jsonb' }),
        ],
        [],
      );
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('users.a, users.b');
    });
  });

  describe('constraints', () => {
    it('spreads a composite primary key across its columns', () => {
      const { schema } = introspect(
        [
          col({ attnum: 1, name: 'user_id', formattedType: 'integer' }),
          col({ attnum: 2, name: 'group_id', formattedType: 'integer' }),
        ],
        [con({ type: 'p', columns: [1, 2], name: 'users_pkey' })],
      );
      expect(schema.tables[0]!.columns.map((c) => c.constraints)).toEqual([
        [{ kind: 'primary_key' }],
        [{ kind: 'primary_key' }],
      ]);
    });

    it('collapses that composite key back into one statement', () => {
      const { schema } = introspect(
        [
          col({ attnum: 1, name: 'user_id', formattedType: 'integer' }),
          col({ attnum: 2, name: 'group_id', formattedType: 'integer' }),
        ],
        [con({ type: 'p', columns: [1, 2], name: 'users_pkey' })],
      );
      expect(migrate({ tables: [] }, diff({ tables: [] }, schema))).toEqual([
        'CREATE TABLE "users" (\n' +
          '  "user_id" integer NOT NULL,\n' +
          '  "group_id" integer NOT NULL,\n' +
          '  CONSTRAINT "users_pkey" PRIMARY KEY ("user_id", "group_id")\n' +
          ');',
      ]);
    });

    it('reads a foreign key through the referenced table oid and attnum', () => {
      const { schema } = introspect(
        [
          col({ tableOid: '1', tableName: 'users', attnum: 1, name: 'id', formattedType: 'integer' }),
          col({ tableOid: '2', tableName: 'posts', attnum: 1, name: 'author', formattedType: 'integer' }),
        ],
        [con({ tableOid: '2', type: 'f', columns: [1], refTableOid: '1', refColumns: [1] })],
      );
      expect(schema.tables[1]!.columns[0]!.constraints).toEqual([
        { kind: 'foreign_key', refTableId: 't1', refColumnId: 'c1.1' },
      ]);
    });

    it('unwraps the parentheses Postgres adds around a CHECK', () => {
      const { schema } = introspect(
        [col({ attnum: 1, name: 'price', formattedType: 'integer' })],
        [con({ type: 'c', columns: [1], definition: 'CHECK ((price > 0))' })],
      );
      expect(schema.tables[0]!.columns[0]!.constraints).toEqual([
        { kind: 'check', expr: 'price > 0' },
      ]);
    });

    it('leaves the inner parentheses of a compound CHECK alone', () => {
      const { schema } = introspect(
        [col({ attnum: 1, name: 'price', formattedType: 'integer' })],
        [con({ type: 'c', columns: [1], definition: 'CHECK (((price > 0) AND (price < 100)))' })],
      );
      expect(schema.tables[0]!.columns[0]!.constraints).toEqual([
        { kind: 'check', expr: '(price > 0) AND (price < 100)' },
      ]);
    });

    it('reads a NOT VALID constraint as the constraint it is', () => {
      const { schema } = introspect(
        [col({ attnum: 1, name: 'price', formattedType: 'integer' })],
        [con({ type: 'c', columns: [1], definition: 'CHECK ((price > 0)) NOT VALID' })],
      );
      expect(schema.tables[0]!.columns[0]!.constraints).toEqual([
        { kind: 'check', expr: 'price > 0' },
      ]);
    });

    it('reports a multi-column unique key instead of pretending it is not there', () => {
      const { schema, notes } = introspect(
        [
          col({ attnum: 1, name: 'a', formattedType: 'integer' }),
          col({ attnum: 2, name: 'b', formattedType: 'integer' }),
        ],
        [con({ type: 'u', columns: [1, 2], name: 'users_a_b_key' })],
      );
      // Absent from both sides of any diff, so never dropped. Still worth saying.
      expect(schema.tables[0]!.columns.flatMap((c) => c.constraints)).toEqual([]);
      expect(notes[0]).toContain('users_a_b_key');
      expect(notes[0]).toContain('not dropped');
    });

    it('keeps a column default', () => {
      const { schema } = introspect(
        [col({ attnum: 1, name: 'at', formattedType: 'timestamp with time zone', defaultExpr: 'now()' })],
        [],
      );
      expect(schema.tables[0]!.columns[0]!.constraints).toEqual([{ kind: 'default', expr: 'now()' }]);
    });
  });

  describe('sizes', () => {
    it('clamps the -1 Postgres reports for a table it has never analysed', () => {
      const { stats } = introspect([col({ attnum: 1, name: 'id' })], [], [
        { tableOid: '16400', rows: -1, bytes: 8192 },
      ]);
      expect(stats.t16400).toEqual({ rows: 0, bytes: 8192 });
    });
  });

  /**
   * The reason ids come from the catalog at all. A rename is instant; a drop and
   * recreate isn't recoverable. Getting this wrong on a live table is the worst
   * thing this tool can do.
   */
  describe('renames', () => {
    const columns = (name: string): CatalogColumn[] => [
      col({ attnum: 1, name: 'id', formattedType: 'integer' }),
      col({ attnum: 2, name, formattedType: 'text' }),
    ];

    it('reads a rename in one database as a rename, because oids do not move', () => {
      const before = introspect(columns('email'), []).schema;
      const after = introspect(columns('email_address'), []).schema;
      expect(migrate(before, diff(before, after))).toEqual([
        'ALTER TABLE "users" RENAME COLUMN "email" TO "email_address";',
      ]);
    });

    it('would destroy the table when comparing two databases, without detectRenames', () => {
      const staging = introspect(columns('email'), []).schema;
      const production = introspect(
        columns('email_address').map((c) => ({ ...c, tableOid: '99999' })),
        [],
      ).schema;

      // Different databases have unrelated oids, so nothing pairs up and every
      // table becomes a drop and an add. On a real table that's every row in it.
      expect(migrate(staging, diff(staging, production))).toEqual([
        'DROP TABLE "users";',
        'CREATE TABLE "users" (\n  "id" integer NOT NULL,\n  "email_address" text NOT NULL\n);',
      ]);

      // Aligning them first turns it back into the metadata change it actually is.
      const aligned = detectRenames(staging, production).schema;
      expect(migrate(staging, diff(staging, aligned))).toEqual([
        'ALTER TABLE "users" RENAME COLUMN "email" TO "email_address";',
      ]);
    });
  });
});
