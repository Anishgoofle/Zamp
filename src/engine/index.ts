export type { Schema, Table, Column, ColumnType, ColumnConstraint } from './model/types.js';
export type { Change, ColumnChange } from './model/change.js';
export { fingerprint } from './internal/canonical.js';
export { diff } from './operations/diff.js';
export { apply } from './operations/apply.js';
export { branch } from './operations/branch.js';
export { validate } from './operations/validate.js';
export { parseSchema } from './operations/parse.js';
export type { ParseResult } from './operations/parse.js';
export type { ValidationError } from './operations/validate.js';
export { merge, resolveMerge } from './operations/merge.js';
export type { MergeResult, ResolvedMerge, Conflict, ConflictKind } from './operations/merge.js';
export { detectRenames } from './operations/rename.js';
export type { RenameResult, RenameMatch } from './operations/rename.js';
export { migrate } from './operations/migrate.js';
export { plan, batches } from './operations/plan.js';
export type { Plan, Step, Batch, Hazard, LockLevel, PlanOptions, TableStats } from './operations/plan.js';
export { introspect } from './operations/introspect.js';
export type {
  Introspection,
  CatalogColumn,
  CatalogConstraint,
  CatalogTableSize,
} from './operations/introspect.js';
export { readCatalog } from './postgres/catalog.js';
export type { Queryable } from './postgres/catalog.js';
export { rehearse, execute } from './postgres/execute.js';
export type { StepResult, RunOptions } from './postgres/execute.js';
