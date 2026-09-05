import type { Schema } from '../model/types';

/**
 * Branch a schema. Plain data with stable ids, so this is just a structural
 * clone — `diff` later re-pairs by id. Branch metadata (name, parent) is the
 * app's concern and wraps a `Schema` rather than living in it.
 */
export function branch(schema: Schema): Schema {
  return structuredClone(schema);
}
