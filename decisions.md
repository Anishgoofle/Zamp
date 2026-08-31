# Decisions

Running log of real decisions and their tradeoffs. Newest last.

---

## Schema is plain JSON-serializable data (tables → columns)

### Thought process

The core object in this app is a database schema, and everything we do to it —
branch, diff, merge — is really an operation on a tree: a schema owns tables, a
table owns columns, a column owns its type and constraints. The question was
what *kind* of object that tree should be.

Two options were on the table:

1. **A rich model** — `Schema` / `Table` / `Column` classes with methods
   (`table.addColumn()`, `column.rename()`, `schema.branch()`), invariants
   enforced in constructors, maybe live cross-references (a foreign key column
   holding a pointer to the table it targets).
2. **Plain data** — nested objects and arrays, no methods, no identity beyond
   the values themselves. All behavior lives in free functions in the engine
   that take a schema in and return a new schema (or a diff, or a merge result)
   out.

We picked plain data.

### Why

- **Branching is just a structural clone.** With plain data, `branch(schema)` is
  `structuredClone(schema)` and nothing else. No re-wiring of internal pointers,
  no "detach from parent," no method that has to know how to duplicate itself. A
  class graph with live references makes cloning a custom, error-prone
  operation; every new field is a chance to forget to copy it.
- **No two branches can accidentally share state.** Once cloned, branch A and
  branch B are fully independent trees. There is no live reference from one into
  the other that a mutation could leak across. This is the whole point of the
  product, so it should be structurally impossible to get wrong, not merely
  "we're careful."
- **Diff and merge become pure tree-walks.** `diff(before, after)` just recurses
  two plain trees and compares values. There's no hidden behavior on a node that
  could make two structurally-equal schemas behave differently.
- **Serialization is free.** Persisting a schema, sticking it in a URL,
  snapshotting it in a test fixture, sending it over the wire — all just
  `JSON.stringify`. A class instance needs a `toJSON` / `fromJSON` pair kept in
  sync with the fields by hand.
- **Tests are trivial to write.** A fixture is a literal object. An assertion is
  `toEqual` on a literal object.

### Cost / tradeoff

- **No behavior lives on the model.** You call an engine function, not
  `column.rename("foo")`. You have to know the engine API rather than dotting
  into an object.
- **No enforced invariants at construction time.** Nothing stops a schema with
  two columns sharing an `id`, or a foreign key pointing at a table that doesn't
  exist. Validation is its own explicit pass (see below), not a constructor
  guarantee.
- **References are by `id`, resolved on demand.** A foreign key stores the
  target's `id` as a string; code that needs the actual target does a lookup.

### Skeleton

```ts
// engine/types.ts — the model is data. No classes, no methods, no live refs.

export interface Schema { tables: Table[] }            // branch metadata is the app's concern

export interface Table  { id: string; name: string; columns: Column[] }

export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  nullable: boolean;
  constraints: ColumnConstraint[];                      // compared as a set
}

export type ColumnType =
  | { kind: 'int' } | { kind: 'bigint' } | { kind: 'text' }
  | { kind: 'varchar'; length: number }
  | { kind: 'boolean' }
  | { kind: 'timestamp'; withTimezone: boolean }
  | { kind: 'numeric'; precision: number; scale: number };

export type ColumnConstraint =
  | { kind: 'primary_key' } | { kind: 'unique' }
  | { kind: 'default'; expr: string }
  | { kind: 'check'; expr: string }
  | { kind: 'foreign_key'; refTableId: string; refColumnId: string };  // by id, resolved on demand

// engine/change.ts — the diff vocabulary (field-level; see "Field-level changes")
export type Change =
  | { kind: 'add_table';       tableId: string; table: Table }
  | { kind: 'drop_table';      tableId: string; table: Table }
  | { kind: 'rename_table';    tableId: string; from: string; to: string }
  | { kind: 'add_column';      tableId: string; columnId: string; column: Column }
  | { kind: 'drop_column';     tableId: string; columnId: string; column: Column }
  | { kind: 'rename_column';   tableId: string; columnId: string; from: string; to: string }
  | { kind: 'change_type';     tableId: string; columnId: string; from: ColumnType; to: ColumnType }
  | { kind: 'change_nullable'; tableId: string; columnId: string; from: boolean; to: boolean }
  | { kind: 'add_constraint';  tableId: string; columnId: string; constraint: ColumnConstraint }
  | { kind: 'drop_constraint'; tableId: string; columnId: string; constraint: ColumnConstraint };

// Operations are free functions. Data in, data out. Inputs never mutated.
export declare function diff(before: Schema, after: Schema): Change[];
export declare function apply(schema: Schema, changes: Change[]): Schema;   // apply(s, diff(s,t)) ≡ t
export declare function branch(schema: Schema): Schema;                     // = structuredClone
export declare function validate(schema: Schema): ValidationError[];
```

---

## Stable `id` on every table and column, separate from `name`

Diff keys off `id`, not `name`. A rename is exactly "same id, new name"; a drop
is "id gone"; an add is "new id". This makes the diff *exact* rather than a
name-similarity heuristic. Rename *detection* (for schemas that arrive without
stable ids, e.g. parsed from DDL) is a separate, explicitly heuristic layer on
top — not yet built.

---

## `diff(before, after)` returns one flat, deterministically ordered array

Both the UI and the (future) merge consume the same change list. One
representation, one ordering, tested once. The order is a total sort on
`(tableId, columnSlot, kind-rank, canonical(constraint))` — table-level changes
sort ahead of any column change in the same table. Deterministic so tests assert
on the array directly and merges are reproducible; independent of the input's
table/column/constraint array ordering.

---

## Field-level changes, not a grouped `modify_column`

A change is one field: a rename, a type, a nullability flip, a single constraint
added or dropped. If branch A changes a column's type and branch B changes the
same column's nullability, they touch different change objects and must *not*
conflict. A grouped `modify_column` would force a false conflict there. Cost:
reconstructing "everything that happened to this column" means scanning several
entries.

---

## Added/dropped tables and columns carry the whole object; constraints are a set

`add_table` / `drop_table` (and the column equivalents) embed the full `Table` /
`Column` rather than decomposing into per-field adds. Those payloads are fully
normalized — object keys sorted, columns ordered by id, constraints ordered
canonically — so diff output is a pure function of schema *content* and
byte-stable under `JSON.stringify` (safe as a snapshot or cache key). Constraints
are diffed as a set, keyed by canonical form: reordering a column's constraint
list produces no change, an (invalidly) repeated identical constraint collapses
to one entry, and changing a `default`'s expression shows as drop + add rather
than a dedicated "change". Cost: a whole-table add isn't decomposed, so a future
merge needing column-level granularity inside a newly-added table will have to
expand it.

---

## Invariants are an explicit `validate()` pass, not constructor guarantees

The plain-data model can't stop a schema with duplicate ids/names or a foreign
key pointing nowhere. `validate(schema)` checks unique table ids and names,
unique column ids and names per table, and resolvable foreign keys, returning
every problem found — the app runs it when a schema enters the system. (Name
uniqueness matters for merge: two branches independently renaming different
columns to the same name is not a slot conflict, so `validate` is what catches
the collision — surfaced as `MergeResult.errors`.)

`diff` and `apply` don't run full validation, but they do **assert** the one
invariant they need for correctness: unique table/column ids. Both pair entries
by id, so a duplicate would silently shadow its twin and produce a wrong answer
(e.g. `diff` reporting no change between two different schemas). Reaching them
with duplicate ids means a broken importer or id generator, so `assertUniqueIds`
throws — same stance as `apply` throwing on a change that targets a missing id.

---

## `branch()` is `structuredClone` and nothing else

Because the schema is plain data with stable ids, branching needs no custom
logic: clone the tree, and a later `diff` re-pairs tables/columns by id. Branch
metadata (name, parent, timestamp) is a separate wrapper the app owns, not part
of `Schema`.

---

## `apply()` ships in Day 1 alongside `diff()`

Not strictly needed to "see a diff," but it makes the diff *verifiable*: the test
suite asserts `diff(apply(before, diff(before, after)), after)` is empty — a
round-trip property that catches whole classes of diff bugs a set of hand-written
expectations would miss. Changes are mutually independent, so `apply` is
order-insensitive and appends new tables/columns (order isn't significant).

---

## Merge is `diff` twice, then reconcile per "slot"

`merge(base, ours, theirs)` runs `diff(base, ours)` and `diff(base, theirs)`,
groups every change by the location it touches — a **slot** like
`table:t:name`, `column:t.c:type`, `column:t.c:constraint:default` — and for each
slot: one side only → take it; both sides identical → take it once; both sides
different → a `Conflict`. The field-level `Change` granularity from Day 1 is what
makes this work: `ours` retyping a column and `theirs` toggling its nullability
land in different slots and both apply.

Singleton constraints (`primary_key`, `unique`, `default`) slot by *kind*, so two
different `default` expressions conflict instead of both applying. `check` and
`foreign_key` may legally repeat, so they slot by full value.

---

## Merge auto-applies what it can; conflicts stay at `base`

`MergeResult.schema` is `base` plus every non-conflicting change. A conflicted
slot is left at its `base` value — not "ours wins" — and carried in
`conflicts[]` with both sides' changes. `resolveMerge(result, picks)` takes an
`ours`/`theirs` choice per conflict and returns `{ schema, errors }` — it
re-`validate`s, because picking a side can still collide (both branches renamed
different columns toward the same name, only one auto-merged, the pick supplies
the other). This keeps the auto-merge honest (it never silently picks a side)
and gives the Day 4 UI a clean resolve-one-at-a-time model.

Conflict kinds: `update/update` (same slot, different values), `add/add` (same
new id, different definition), `delete/update` (one side drops a table/column,
the other makes *any* other change to it). `delete/update` fires even when the
other side's change is itself a deletion — dropping a column of a table the other
branch drops whole — because the branch that only dropped the column still has
the table, so the two disagree on its existence; merging silently would lose the
columns that branch kept.

Cross-entity inconsistency — `ours` adds a foreign key to a table `theirs` drops
— is **not** a conflict; it surfaces as `MergeResult.errors` from
`validate(schema)`, since catching it means re-deriving references, not comparing
change slots.

---

## Rename detection is a separate heuristic layer, name-match before signature

The exact `diff` is pure id-based; `detectRenames(before, after)` runs *before*
it, for schemas that arrive without stable ids (parsed DDL). It aligns `after`'s
tables/columns to `before` in two passes — identical name first (ids were just
regenerated), then structural signature for the leftovers (a real rename) — and
reuses `before`'s id so the following `diff` reports `rename_*` or nothing
instead of drop + add. Only **unambiguous** matches are taken (exactly one
candidate on each side); when two dropped columns share a signature with two
added ones, it leaves them as drop + add rather than guessing. Keeping this
separate means the core diff stays exact and testable without the heuristic.

Signatures exclude *names*: a column signature is its type + nullability +
constraint set, a table signature is the multiset of its column signatures. So a
table that was renamed *and* had a column renamed still matches — the uniqueness
requirement is what stops two unrelated tables with the same column shape from
being paired. A foreign key's signature is reduced to just its *kind* (its target
ids are regenerated in the parsed-DDL case, so matching on them is pointless); a
final pass rewrites every reconciled FK's `refTableId`/`refColumnId` to the kept
ids, so the following `diff` and `validate` see a stable, resolvable reference.
