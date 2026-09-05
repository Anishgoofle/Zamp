import { checkExpression } from './sqlExpression.js';
import { validate } from './validate.js';
import type { Schema } from '../model/types.js';

export type ParseResult = { schema: Schema; errors: null } | { schema: null; errors: string[] };

const TYPE_KINDS = ['int', 'bigint', 'text', 'varchar', 'boolean', 'timestamp', 'numeric', 'other'];
const CONSTRAINT_KINDS = ['primary_key', 'unique', 'default', 'check', 'foreign_key'];

/**
 * The boundary every untrusted schema crosses: the JSON in the editor, and the
 * target a browser POSTs to /api/apply. Past here a value is typed as `Schema`
 * and trusted, so the shape check has to cover the unions too. An unrecognised
 * type.kind sails through `validate` and comes out as ALTER COLUMN ... TYPE
 * undefined.
 */
export function parseSchema(value: unknown): ParseResult {
  if (!looksLikeSchema(value)) {
    return { schema: null, errors: ['Expected { "tables": [ { id, name, columns: [...] } ] }'] };
  }

  // Size, identifiers, SQL fragments, invariants. In that order, so an enormous
  // input is rejected before anything walks it twice.
  const errors = [
    ...tooBig(value),
    ...badIdentifiers(value),
    ...badExpressions(value),
  ];
  if (errors.length > 0) return { schema: null, errors };

  const problems = validate(value);
  return problems.length > 0
    ? { schema: null, errors: problems.map((e) => e.message) }
    : { schema: value, errors: null };
}

/**
 * Bounds. Everything downstream is at least linear in these and some of it is
 * worse: detectRenames compares every unmatched entity against every other. Set
 * generously (the largest production Postgres databases run to a few thousand
 * tables) but low enough that a hand-written request can't stall the server.
 */
const MAX_TABLES = 2_000;
const MAX_COLUMNS = 20_000;
const MAX_CONSTRAINTS_PER_COLUMN = 50;

function tooBig(schema: Schema): string[] {
  if (schema.tables.length > MAX_TABLES) {
    return [`${schema.tables.length} tables; this tool handles up to ${MAX_TABLES}.`];
  }
  let columns = 0;
  for (const table of schema.tables) {
    columns += table.columns.length;
    for (const column of table.columns) {
      if (column.constraints.length > MAX_CONSTRAINTS_PER_COLUMN) {
        return [
          `${table.name}.${column.name} has ${column.constraints.length} constraints; ` +
            `the limit is ${MAX_CONSTRAINTS_PER_COLUMN}.`,
        ];
      }
    }
  }
  return columns > MAX_COLUMNS
    ? [`${columns} columns in total; this tool handles up to ${MAX_COLUMNS}.`]
    : [];
}

/**
 * Postgres silently truncates identifiers at 63 bytes, so two names differing only
 * past that point collapse into one object. Generated constraint names concatenate
 * a table and a column name, so the real budget is tighter than it looks. Reject
 * early rather than emit DDL that means something other than it reads.
 */
const MAX_IDENTIFIER_BYTES = 63;

function badIdentifiers(schema: Schema): string[] {
  const errors: string[] = [];
  const utf8 = new TextEncoder();

  const check = (name: string, what: string): void => {
    if (name.length === 0) errors.push(`${what} has an empty name.`);
    else if (name !== name.trim()) errors.push(`${what} name "${name}" has leading or trailing whitespace.`);
    else if (utf8.encode(name).length > MAX_IDENTIFIER_BYTES) {
      errors.push(
        `${what} name "${name.slice(0, 20)}…" is longer than ${MAX_IDENTIFIER_BYTES} bytes, ` +
          `which Postgres would silently truncate.`,
      );
    } else if (name.includes('\u0000')) errors.push(`${what} name contains a NUL byte.`);
  };

  for (const table of schema.tables) {
    check(table.name, 'a table');
    for (const column of table.columns) check(column.name, `${table.name}: a column`);
  }
  return errors;
}

/** The two constraint kinds that carry SQL text rather than an identifier. */
function badExpressions(schema: Schema): string[] {
  const errors: string[] = [];
  for (const table of schema.tables) {
    for (const column of table.columns) {
      for (const constraint of column.constraints) {
        if (constraint.kind !== 'check' && constraint.kind !== 'default') continue;
        const problem = checkExpression(
          constraint.expr,
          `${table.name}.${column.name} (${constraint.kind})`,
        );
        if (problem) errors.push(problem);
      }
    }
  }
  return errors;
}

function looksLikeSchema(value: unknown): value is Schema {
  return isObject(value) && Array.isArray(value.tables) && value.tables.every(isTableShaped);
}

function isTableShaped(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    Array.isArray(value.columns) &&
    value.columns.every(isColumnShaped)
  );
}

function isColumnShaped(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.nullable === 'boolean' &&
    hasKindIn(value.type, TYPE_KINDS) &&
    Array.isArray(value.constraints) &&
    value.constraints.every((c) => hasKindIn(c, CONSTRAINT_KINDS))
  );
}

function hasKindIn(value: unknown, kinds: readonly string[]): boolean {
  return isObject(value) && typeof value.kind === 'string' && kinds.includes(value.kind);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
