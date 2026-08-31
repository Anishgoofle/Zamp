# engine/

Pure TypeScript. **Zero React imports.** Data in, data out. Every function takes
plain schema data and returns plain data; nothing here mutates its input.

## Modules

- `types.ts` — the schema model: `Schema` → `Table` → `Column`, each table and
  column with a stable `id` separate from its `name`. Plain JSON-serializable
  data, no methods.
- `change.ts` — the `Change` union: the diff vocabulary that `diff` emits and
  `apply` consumes. Field-level, so a type change and a nullability change on one
  column are separate entries.
- `diff.ts` — `diff(before, after): Change[]`, one flat, deterministically
  ordered array. Output depends only on schema content, not on array ordering in
  the input.
- `apply.ts` — `apply(schema, changes): Schema`. `apply(s, diff(s, t))` has no
  remaining diff to `t`. Throws on a change whose target table/column is absent.
- `branch.ts` — `branch(schema): Schema`, a structural clone.
- `validate.ts` — `validate(schema): ValidationError[]`, the invariants the
  plain-data model can't enforce at construction (unique ids, resolvable foreign
  keys). The app runs it on import; `diff`/`apply` assume it has passed.
- `merge.ts` — `merge(base, ours, theirs): MergeResult` — three-way merge:
  `diff`s each side, applies non-conflicting changes, reports the rest as
  `Conflict`s (`add/add` / `update/update` / `delete/update`). `resolveMerge`
  applies an ours/theirs pick per conflict.
- `rename.ts` — `detectRenames(before, after): RenameResult` — heuristic layer
  for schemas without stable ids: aligns entities by name then by signature so a
  following `diff` sees `rename_*` instead of drop + add. Unambiguous matches
  only.
- `canonical.ts` — internal: stable stringify / deep key-sort for structural
  equality and sort keys.
- `collections.ts` — internal: `byId`, and `assertUniqueIds` (the id-uniqueness
  precondition `diff` and `apply` throw on).

Import from `@engine` (the barrel) at call sites.

## Not yet built

- migration output — `Change[]` (or `MergeResult.changes`) → runnable
  `ALTER TABLE` (Day 3).

## The boundary

If anything here imports from `../app`, the engine stops being exhaustively
testable without rendering. Don't cross it.
