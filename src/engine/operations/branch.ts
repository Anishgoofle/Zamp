import type { Schema } from '../model/types.js';

/**
 * Branch a schema. Plain data with stable ids, so a structural clone is all it
 * takes; `diff` re-pairs by id later. Branch metadata (name, parent) belongs to
 * the app and wraps a Schema rather than living inside one.
 */
export function branch(schema: Schema): Schema {
  return structuredClone(schema);
}
