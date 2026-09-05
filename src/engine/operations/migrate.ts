import { plan } from './plan.js';
import type { Change } from '../model/change.js';
import type { Schema } from '../model/types.js';

/**
 * Render a change list (from `diff`, or `merge(...).changes`) as PostgreSQL DDL.
 * One `;`-terminated statement per entry, ordered to run top to bottom.
 *
 * This is the direct version: each change becomes the statement you'd write by
 * hand, including the ones that hold ACCESS EXCLUSIVE across a full scan. Good
 * for reading and reviewing, and fine against an empty database. For a table with
 * rows in it use `plan(before, changes)`, which decomposes those statements and
 * reports what each one locks.
 */
export function migrate(before: Schema, changes: readonly Change[]): string[] {
  return plan(before, changes, { online: false }).steps.map((step) => step.sql);
}
