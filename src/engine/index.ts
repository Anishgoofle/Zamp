export type { Schema, Table, Column, ColumnType, ColumnConstraint } from './model/types';
export type { Change, ColumnChange } from './model/change';
export { fingerprint } from './internal/canonical';
export { diff } from './operations/diff';
export { apply } from './operations/apply';
export { branch } from './operations/branch';
export { validate } from './operations/validate';
export { parseSchema } from './operations/parse';
export type { ParseResult } from './operations/parse';
export type { ValidationError } from './operations/validate';
export { merge, resolveMerge } from './operations/merge';
export type { MergeResult, ResolvedMerge, Conflict, ConflictKind } from './operations/merge';
export { detectRenames } from './operations/rename';
export type { RenameResult, RenameMatch } from './operations/rename';
export { migrate } from './operations/migrate';
export { plan, batches } from './operations/plan';
export type { Plan, Step, Batch, Hazard, LockLevel, PlanOptions, TableStats } from './operations/plan';
export { introspect } from './operations/introspect';
export type {
  Introspection,
  CatalogColumn,
  CatalogConstraint,
  CatalogTableSize,
} from './operations/introspect';
export { readCatalog } from './postgres/catalog';
export type { Queryable } from './postgres/catalog';
export { rehearse, execute } from './postgres/execute';
export type { StepResult, RunOptions } from './postgres/execute';
