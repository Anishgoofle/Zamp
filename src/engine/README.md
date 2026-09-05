# engine/

Plain TypeScript. **Zero React imports, no driver imports.** Data in, data out;
nothing here mutates its input.

```
index.ts       the public barrel — import from `@engine`, never a subpath
model/         plain data, no logic
internal/      helpers, not re-exported
operations/    the public verbs, one file per function
postgres/      the one place there is I/O, behind an injected interface
```

Dependencies point one way: `operations` → `model` + `internal`, `internal` →
`model`, `model` → nothing.

## model/

- `types.ts` — `Schema` → `Table` → `Column`. Every table and column carries a
  stable `id` separate from its `name`. `ColumnType` spells out seven Postgres
  types plus `{ kind: 'other', sql }`, which carries anything else verbatim so an
  introspected `jsonb` column survives a round trip instead of being dropped.
- `change.ts` — the `Change` union that `diff` emits and `apply` consumes.
  Field-level, so a type change and a nullability change on one column are
  separate entries and don't conflict.

## internal/

- `canonical.ts` — stable stringify, deep key-sort, structural equality, and
  `fingerprint` (the schema identity that `/api/apply` checks for drift).
- `collections.ts` — `byId`, and `assertUniqueIds`, the precondition `diff` and
  `apply` throw on.

## operations/

- `diff.ts` — `diff(before, after): Change[]`. One flat, deterministically ordered
  array; output depends only on schema content, not on input array order.
- `apply.ts` — `apply(schema, changes): Schema`. `apply(s, diff(s, t))` has no
  remaining diff to `t`. Throws when a change targets an id that isn't there.
- `branch.ts` — `branch(schema)`, a structural clone. That's the whole feature.
- `validate.ts` — the invariants plain data can't enforce at construction: unique
  ids and names, resolvable foreign keys.
- `parse.ts` — `parseSchema(value)`, the boundary every untrusted schema crosses.
  Shape check plus `validate`, used by both the JSON editor and `/api/apply`, so
  the two agree on what a schema is.
- `merge.ts` — `merge(base, ours, theirs)` and `resolveMerge(result, picks)`.
  Three-way merge by slot; conflicts stay at base rather than picking a side.
- `rename.ts` — `detectRenames(before, after)`. Re-pairs two schemas that don't
  share ids, by name then by structural signature, so the following diff sees
  `rename_*` instead of drop + add. Unambiguous matches only.
- `introspect.ts` — catalog rows → `Schema`. Ids are the `oid` and the `attnum`,
  which is what makes a rename in a live database exact rather than heuristic.
  Pure, so it's testable without a database.
- `plan.ts` — `plan(before, changes, options): Plan`. Re-buckets the flat diff
  into dependency-safe phases, and annotates every statement with what it locks.
  In online mode it decomposes the four statements that would hold `ACCESS
  EXCLUSIVE` across a full scan. The interesting file.
- `migrate.ts` — `migrate(before, changes): string[]`, which is
  `plan(..., { online: false })` rendered to strings. The textbook DDL, for
  reading and reviewing.

## postgres/

The dialect's other half — the engine already *writes* PostgreSQL, this reads it
back and runs it.

- `catalog.ts` — `readCatalog(db, schemaName)`. Three `SELECT`s against
  `pg_catalog` (not `information_schema`, which hides oids and
  `pg_get_constraintdef`), mapped through `introspect`.
- `execute.ts` — `rehearse` runs a plan inside a transaction and rolls back;
  `execute` runs it and keeps it, batching so a failure inside a transaction takes
  the whole batch back out.

Both take a structural `Queryable` — anything with a `query` — so there is no
dependency on `pg`, and the tests run the real cycle against an in-process
Postgres.

## The boundary

If anything here imports from `../app`, the engine stops being testable without
rendering. Callers import the `@engine` barrel, not subpaths.
