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

- **Branching is just a structural clone.** With plain data,
  `branch(schema)` is a deep copy — `structuredClone(schema)` — and nothing
  else. No re-wiring of internal pointers, no "detach from parent," no method
  that has to know how to duplicate itself. A class graph with live references
  makes cloning a custom, error-prone operation; every new field is a chance to
  forget to copy it.
- **No two branches can accidentally share state.** Once cloned, branch A and
  branch B are fully independent trees. There is no live reference from one into
  the other that a mutation could leak across. This is the whole point of the
  product, so it should be structurally impossible to get wrong, not merely
  "we're careful."
- **Diff and merge become pure tree-walks.** `diff(before, after)` just
  recurses two plain trees and compares values. There's no hidden behavior on a
  node that could make two structurally-equal schemas behave differently, and no
  need to "freeze" or normalize an object before comparing it.
- **Serialization is free.** Persisting a schema, sticking it in a URL, snap-
  shotting it in a test fixture, sending it over the wire — all just
  `JSON.stringify`. A class instance needs a `toJSON` / `fromJSON` pair that has
  to be kept in sync with the fields by hand.
- **Tests are trivial to write.** A fixture is a literal object. An assertion
  is `toEqual` on a literal object. No builders, no mocks.

### Cost / tradeoff

- **No behavior lives on the model.** You can't do `column.rename("foo")`;
  you call an engine function. Discoverability is worse — you have to know the
  engine API rather than dotting into an object.
- **No enforced invariants at construction time.** Nothing stops you from
  hand-building a schema with two columns sharing an `id`, or a foreign key
  pointing at a table that doesn't exist. Validation has to be its own explicit
  pass (`validate(schema)`), not a constructor guarantee.
- **References are by `id`, resolved on demand.** A foreign key stores the
  target table's `id` as a string; code that needs the actual target does a
  lookup. Slightly more verbose at the use site than following a pointer.

We accept this because the engine is small and the functions are the API. The
alternative's costs (fragile cloning, shared-state bugs, serialization drift)
are exactly the costs this product cannot afford.

### Skeleton (structures)

```ts
// engine/types.ts — the whole model is data. No classes, no methods.

/** A full database schema. This is the versioned artifact. */
export interface Schema {
  /** Stable identity for the schema itself (a branch is a clone with the same or new id — TBD). */
  id: string;
  tables: Table[];
}

export interface Table {
  /** Stable, opaque. Diff keys off this, never off `name`. */
  id: string;
  name: string;
  columns: Column[];
  // later: indexes, table-level constraints
}

export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  nullable: boolean;
  /** Field-level so branches touching different constraints don't false-conflict. */
  constraints: ColumnConstraint[];
}

export type ColumnType =
  | { kind: 'int' }
  | { kind: 'bigint' }
  | { kind: 'text' }
  | { kind: 'varchar'; length: number }
  | { kind: 'boolean' }
  | { kind: 'timestamp'; withTimezone: boolean }
  | { kind: 'numeric'; precision: number; scale: number };

export type ColumnConstraint =
  | { kind: 'primary_key' }
  | { kind: 'unique' }
  | { kind: 'default'; expr: string }
  | { kind: 'check'; expr: string }
  /** Reference held by id, resolved on demand — no live pointer into another table. */
  | { kind: 'foreign_key'; refTableId: string; refColumnId: string };

// Operations are free functions: data in, data out. Nothing mutates its input.

/** Branch = structural clone. That's the entire implementation. */
export declare function branch(schema: Schema): Schema; // structuredClone(schema)

/** Invariants are an explicit pass, not a constructor guarantee. */
export declare function validate(schema: Schema): ValidationError[];
```
