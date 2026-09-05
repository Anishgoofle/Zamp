import { plan } from './plan';
import type { Change } from '../model/change';
import type { Schema } from '../model/types';

/**
 * Render a change list (from `diff`, or `merge(...).changes`) as PostgreSQL DDL —
 * one `;`-terminated statement per array entry, in an order that is safe to run
 * top to bottom.
 *
 * This is the *direct* plan: each change becomes the statement you would write by
 * hand, including the ones that hold ACCESS EXCLUSIVE across a full table scan.
 * That is the right output to read, review, and paste into a review tool, and it
 * is fine to run against an empty database. Anything with rows in it wants
 * `plan(before, changes)` instead, which decomposes those statements and tells you
 * what each one locks.
 */
export function migrate(before: Schema, changes: readonly Change[]): string[] {
  return plan(before, changes, { online: false }).steps.map((step) => step.sql);
}
