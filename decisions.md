# Decisions

Notes I kept while building this, roughly in the order the decisions came up.

Most of it I'd defend. Three things I got wrong and had to go back for — a
heuristic I wrote and then never called, a quadratic algorithm I hid behind a
memo instead of fixing, and a SQL injection I only found because I sat down and
tried to break my own API. Those are written up in full, because how someone
finds their own mistakes says more than a list of things that went well.

---

## What I decided to build

"Version control for database schemas" can mean two quite different products, and
the choice between them is the whole shape of the thing.

The common reading is **a better migration-file tool**: you write `003_add_email.sql`,
the tool tracks which files have run where. That's Flyway, Liquibase, Rails
migrations, Alembic. It's a solved problem and — more to the point — *it cannot
merge*. Two branches that each append `003_*.sql` don't have a schema conflict,
they have a filename conflict. Git will happily merge both files and leave you
with two migrations that both try to add a column. The tool has nothing to say
about it, because the thing it versions is a list of scripts, not a schema.

So I read it the other way: **version the schema itself, and treat the migration
as output**. The user edits a desired state; `diff` derives the changes; `merge`
reconciles two divergent states against a common ancestor; the SQL falls out at
the end. That's the reading where "branch, diff, merge" are real operations
rather than metaphors, and where a three-way merge is even definable.

The cost I accepted, and it is a real one: you cannot express anything that isn't
in the schema. A migration file can carry a data backfill, a `pg_notify`, an
`UPDATE` to reshape rows for a new constraint. A desired-state tool can't, and
that's a genuine gap for anything past pure DDL.

### Who I think this is for

I had a specific person in mind, because "schema tool" is otherwise unboundedly
large. Someone who owns a Postgres database with real data in it, on a team where
more than one person changes the schema. Concretely, two problems that are usually
treated as unrelated:

The first is the merge. Two people branch, both change the schema, and reconciling
them is a manual read of two migration files and a guess. That's the problem the
brief names.

The second is the one they actually lose sleep over: **you cannot tell, by looking
at a migration, whether it will take production down.** `ALTER TABLE ... SET NOT
NULL` is one line and reads like nothing. On a 5GB table it holds an exclusive lock
across a full scan, every query queues behind it, and the connection pool is gone in
about forty seconds. The knowledge of which statements do that lives in senior
engineers' heads and in a handful of blog posts, and it is invisible at review time
because the dangerous statement and the harmless one are the same shape.

So the product is a merge tool that also refuses to let you learn that the hard way.
Which is why every statement carries a lock badge, why the hazards quote the actual
table size, and why *Rehearse* exists at all. If someone uses this and the only thing
they take away is "oh, `ADD UNIQUE` builds the index under an exclusive lock" — that
is a good outcome and most of the point.

**Scope, decided on day one and mostly held:**

- **Postgres only.** The type model, the lock semantics, the constraint naming
  conventions and half of `plan()` are Postgres-specific. A dialect abstraction
  would have been a week of work to make the interesting part *worse* — the
  lock-safety rules I care most about have no MySQL equivalent.
- **Schema, not data.** The one exception is where data forces the schema's hand,
  which turned out to be most of what makes this hard.
- **Tables and columns.** Not views, triggers, functions, sequences, partitions,
  RLS policies, or standalone indexes.

The thing I keep coming back to is that the interesting half of this problem
isn't the merge. It's that the schema you're merging *has 5GB sitting under it*,
and almost every naive answer either takes the table offline or destroys it.

---

## Day 1 — the model

### The schema is plain data, not a class graph

`Schema` → `Table` → `Column`, all plain JSON-serialisable objects. No methods,
no live references, no base class.

The alternative I actually considered was a small class graph — `table.addColumn()`,
`column.rename()`, a foreign key holding a pointer to the table it targets, and
invariants enforced in constructors. It's the more conventional shape and it puts
behaviour where you'd look for it.

I went with plain data for one reason that dominated the rest: **`branch()` becomes
`structuredClone()` and nothing else.** With live references, cloning a schema is a
custom graph walk, and every field added later is a chance to forget to copy one —
which surfaces as two branches quietly sharing state, which is the single worst bug
this product could have. With plain data it's structurally impossible. Serialisation
is free, test fixtures are object literals, and `diff` is a tree walk with no hidden
behaviour on the nodes.

What it costs: no invariants at construction. Nothing stops you building a schema
with two columns sharing an id, or a foreign key pointing at a table that doesn't
exist. That has to be a separate pass, which is the next decision.

### Stable ids, separate from names

Every table and column carries an opaque `id` that is not its name. `diff` pairs
entities by id and never by name, which makes a rename exactly "same id, new
name", a drop "id gone", an add "new id".

The alternative is name-based matching with a similarity heuristic to spot
renames. Every schema-diff tool that has no ids has to do this, and it is
guesswork: `email` → `email_address` might be a rename or might be a drop and an
add, and the tool cannot know.

Keying on ids makes the core diff *exact* — no heuristic, no configuration, no
false positives. The obvious problem is that a schema arriving from outside
doesn't have our ids, which I knew on day one, wrote a solution for on day two,
and then failed to actually connect to anything until day five. That's the worst
mistake in this project and it gets its own section below.

### One change per field, not a grouped `modify_column`

A `Change` is a single field: a rename, a type, a nullability flip, one constraint
added or dropped. The obvious alternative is a `modify_column` carrying the before
and after column.

The reason is entirely about merge, two days later. If `ours` changes a column's
type and `theirs` changes the same column's nullability, those are not in
conflict, and a grouped change would force one. Field-level granularity is what
makes the merge sharp instead of pessimistic.

Cost: reconstructing "everything that happened to this column" means scanning
several entries instead of reading one.

### `validate()` is a pass, not a promise

Since the model can't enforce its own invariants, `validate(schema)` checks them
explicitly: unique ids and names, resolvable foreign keys. It returns every
problem rather than throwing on the first, because the UI shows them all at once.

`diff` and `apply` don't run it — they'd be doing it on every call for no reason —
but they do `assertUniqueIds` and **throw**, because a duplicate id would make them
silently pair the wrong entities and return a confidently wrong answer. A wrong
diff is worse than a crash. Reaching that state means the caller is broken, so it
throws rather than returning an error the caller might ignore.

`apply` shipped on day one alongside `diff`, which wasn't strictly needed to "see
a diff". It earns its place as a test oracle: the suite asserts
`diff(apply(before, diff(before, after)), after)` is empty, and that round-trip
catches whole classes of diff bug that hand-written expectations miss.

---

## Day 2 — merge

### Three-way merge, reconciled per slot

`merge(base, ours, theirs)` runs `diff` twice and groups every change by the
location it touches — a *slot*, like `column:t.c:type` or
`column:t.c:constraint:default`. One side touched a slot, take it. Both sides
touched it identically, take it once. Both differently, that's a conflict.

The alternative was operational transform style — replay one side's changes on top
of the other. I didn't want it: it needs every change to know how to rebase past
every other change, which is O(kinds²) special cases, and the failure mode is a
merge that silently produces something neither side asked for.

Slots make singleton constraints work properly. `primary_key`, `unique` and
`default` slot by *kind*, so two different default expressions conflict instead of
both landing. `check` and `foreign_key` may legitimately repeat on one column, so
they slot by full value.

### A conflict stays at base; the user picks

`MergeResult.schema` is base plus every non-conflicting change. A conflicted slot
is left at its **base** value — not "ours wins", not "last writer wins" — and
carried in `conflicts[]` with both sides' changes attached. `resolveMerge(result,
picks)` takes an ours/theirs choice per conflict and re-runs `validate`, because
picking a side can create a collision that neither side had alone.

Defaulting to one side would have been less code and a worse product. The entire
value of a merge tool is that it doesn't quietly choose for you.

One case I had to think about twice: `delete/update` fires even when the "update"
is itself a deletion — one branch drops a column of a table the other branch drops
whole. It's tempting to call that agreement. It isn't: the branch that only
dropped a column still has the table and all its other columns, so the two sides
genuinely disagree about whether the table should exist, and merging silently
would throw away everything that branch kept.

Cross-entity inconsistency — `ours` adds a foreign key to a table `theirs` drops —
is deliberately *not* a conflict. It isn't a disagreement about a slot, it's a
broken result, so it surfaces through `validate` as `MergeResult.errors`. Catching
it as a conflict would mean re-deriving reference graphs inside the merge, which
is the wrong place for it.

### Rename detection is a separate layer, and says so

`detectRenames(before, after)` re-pairs two schemas that don't share ids: first by
identical name (ids were regenerated but nothing moved), then by structural
signature for whatever's left (a real rename). Only unambiguous matches are taken —
exactly one candidate on each side — so when two dropped columns have the same
shape as two added ones it leaves them as drop and add rather than guessing.

Keeping it out of `diff` was deliberate. The core diff stays exact and testable;
the guessing lives in one file with its own tests and its own name, and callers
opt into it. Signatures exclude names, so a table that was renamed *and* had a
column renamed still matches; the uniqueness requirement is what stops two
unrelated tables with the same column shape from being paired.

I was pleased with this and then didn't wire it up for three days. See below.

---

## Day 3 — turning a diff into SQL

### Phases, not diff order

`diff` output is ordered for determinism, not execution. Run top to bottom it will
happily `ALTER` a table before creating it. `plan()` re-buckets into phases:

```
drop constraint -> drop column -> drop table (FK-ordered)
  -> rename table -> rename column
  -> create table -> add column -> alter column
  -> add constraint -> add foreign key -> validate
```

Three orderings inside that took real thought:

**Drops go before renames**, so a name freed by a drop is available to a rename in
the same changeset (`drop full_name`, then `name -> full_name`).

**Table drops are topologically sorted** over the foreign key graph, so a table is
dropped before anything it references. A mutual-FK cycle is broken at an arbitrary
edge, because no ordering is safe there — it needs `CASCADE` or an explicit
constraint drop first, and I'd rather emit something that fails loudly than
pretend.

**Renames are sequenced, not emitted in diff order.** `a -> b, b -> c` has to emit
`b -> c` first. And a *swap* can't be ordered at all, so one member is parked on a
temporary name and lands on its real one at the end: three statements via `a__tmp`.
This is the kind of thing that never comes up in a demo and ruins someone's evening
in production.

### Names resolve in two different contexts

Everything uses the post-migration name, from `apply(before, changes)`. The
exception is drop statements, because **Postgres does not rename a constraint when
its table is renamed**. So `DROP CONSTRAINT` on a table that's also being renamed
has to use the pre-rename name. Two lookups, `now` and `was`, and getting them
backwards produces DDL that looks right and fails at runtime.

### A primary key is collapsed, not repeated

The model attaches `primary_key` per column, so a composite key is two columns each
carrying one. Emitting that literally gives two constraints with the same generated
name, both claiming to be the primary key. `plan` gathers them per table and emits
one `PRIMARY KEY (a, b)`.

Constraint names follow Postgres's own convention (`t_pkey`, `t_c_fkey`) so a
generated `DROP CONSTRAINT` matches what a hand-written `CREATE TABLE` produced,
and a name generated twice in one run gets Postgres's numeric suffix rather than
colliding.

*Cut:* the model doesn't carry constraint names, so dropping one of several
identically-named constraints is still a guess. Adding names would have meant
plumbing them through diff, merge and conflict slots for a case I couldn't
construct in a real schema.

---

## Day 4 — the workbench

### Everything derives; there is no Run button

The three schemas are `useState`. Everything else — both diffs, the auto-merged
list, the conflict cards, the merged schema, the plan — is derived per render. Edit
a pane and the whole pipeline recomputes.

The alternative was a staged UI with an explicit Compute step. It would have been
easier to make fast, and it would have taught people less. Watching the plan change
as you type is what makes the lock badges land: you change `nullable` to `false` and
four statements appear where one was.

### Three JSON textareas, not a schema builder

A form-based editor — add column, pick type from a dropdown — would look more like a
product. I didn't build one. It's a lot of UI that has to be kept in sync with the
type union, and every hour spent on it is an hour not spent on the part of the
problem that's actually hard. The schema is plain JSON by design, so a textarea is a
complete editor for it, and it makes the model visible, which for a tool aimed at
people who read `pg_dump` output is arguably the better interface anyway.

*Cut:* syntax highlighting in the editors, autocomplete, and a visual schema
diagram. All of them are polish on the half of the product I was least worried about.

### Two things the derived model had to get right

**A pick is keyed by the conflict id *and* both sides' payloads**, not the id alone.
Conflict ids name a location, so an id-keyed pick would silently carry over to a
differently-valued conflict in the same slot after an edit — the user would get a
decision they never made, on a value they never saw. Verified in a browser: resolve
a conflict, change `ours` from `varchar(200)` to `varchar(500)`, and it correctly
drops back to unresolved.

**Nothing falls back on failure.** An earlier version, when `resolveMerge` threw,
fell back to rendering `result.schema` — the *pre*-resolution merge, with conflicted
slots still at base — labelled "Valid", with every conflict showing as resolved.
That is exactly the class of quiet wrong answer this tool exists to prevent, and I
had written it into the tool. Now every failure path says what failed.

### Applying takes two clicks, and the second one names the database

Everything in this tool is reversible except one button. For most of the build,
*Apply for real* was a single unconfirmed click that ran DDL against a live
database — which is a strange thing to ship in a product whose entire argument is
that people underestimate how dangerous schema changes are.

It's now two steps, and the second one is deliberately the loudest thing on the
page. It names the number of statements, names any that discard data and cannot be
undone (`drop table order_tags`), says so if you haven't rehearsed yet, and — the
part I care most about — **names the database**.

That last one came from noticing the API already returned it and the UI was throwing
it away. `/api/introspect` reports a credential-free `source` like `shop on
db.example.com`, and where a deployment lets the browser supply a connection string,
"which database am I about to alter" is a question nobody asks until afterwards. It
is now on screen from the moment you connect, next to the schema name and the
fingerprint, and repeated on the confirm button itself.

The alternative was a browser `confirm()`, which is one line. It can't show which
statements are destructive, can't be styled to look more serious than the rehearse
button next to it, and trains people to click through dialogs. An inline step that
has to say something specific is harder to dismiss without reading.

---

## Day 5 — the real database

Two constraints reshaped the last day: the product has to apply changes to a real
database, and it has to work when a table has 5GB in it. Both turned out to be the
same problem wearing different hats — almost every naive answer is either an outage
or data loss.

### Ids come from `pg_catalog`, and the bug that forced it

Here's the mistake. `detectRenames` was written on day two, exported from the
barrel, and covered by nine tests. It was called by nothing. Tested dead code reads
exactly like a working feature, which is why it survived three days of me looking
at this repo.

It mattered because of how a schema enters the system from a real database. Read
one, and it arrives with names, not with our ids — so ids get regenerated on every
read, nothing pairs up, and the exact id-based diff decides every table was dropped
and a new one created:

```
DROP TABLE "users";
CREATE TABLE "users" ( "id" integer NOT NULL, "email_address" text NOT NULL );
```

That's the output for renaming one column. On a 5GB table it is not a slow
migration, it is a restore from backup. The correct answer is one instant metadata
change:

```
ALTER TABLE "users" RENAME COLUMN "email" TO "email_address";
```

Two fixes, both needed.

**Ids now come from the catalog.** A table is its `oid`, a column is `oid.attnum`.
Both are stable across renames and across repeated reads of the same database, so a
rename in a live database is detected *exactly* — no heuristic at all. I'd been
treating "no stable ids" as inherent to reading a real database, and it isn't;
Postgres has had them the whole time. `information_schema` would have been more
portable and cannot give you oids, which is why the catalog queries go to
`pg_catalog` directly.

**`detectRenames` finally does its job** for the case oids can't cover: two
*different* databases (staging vs production) have unrelated oids, so comparing them
needs the heuristic. `/api/apply` runs it automatically when the target's ids don't
match the live database, and returns the matches it inferred in the response — a
heuristic that fires silently is worse than one that doesn't fire.

The regression test asserts the destructive output explicitly, so if the wiring ever
comes loose the test says `DROP TABLE` out loud.

### `plan()` knows what each statement costs

This is the piece I'd point at first. `migrate()` renders the textbook DDL for each
change. On an empty database that's fine. On a table with rows in it, four of those
statements hold `ACCESS EXCLUSIVE` across a full scan, which means every query on the
table queues behind them:

| you asked for | the textbook statement does |
| --- | --- |
| `SET NOT NULL` | seq-scans the table under an exclusive lock |
| `ADD CHECK` | same |
| `ADD FOREIGN KEY` | same, and locks the referenced table too |
| `ADD UNIQUE` | builds the whole index under an exclusive lock |

`plan()` annotates every statement `instant` / `concurrent` / `blocking`, and in
online mode decomposes the blocking ones:

- `SET NOT NULL` becomes four statements — add `CHECK (col IS NOT NULL) NOT VALID`
  (no scan), `VALIDATE CONSTRAINT` (scans, but under a lock that lets reads and
  writes through), then `SET NOT NULL`, which since PG 12 is free because the
  validated check already proves it, then drop the scaffolding.
- `ADD CHECK` and `ADD FOREIGN KEY` become `NOT VALID` plus a separate `VALIDATE`.
- `ADD UNIQUE` becomes `CREATE UNIQUE INDEX CONCURRENTLY` plus
  `ADD CONSTRAINT ... USING INDEX`, turning the `ALTER` into a catalog flip.

Type changes get the opposite treatment: **there is no online form, so it says so.**
It works out which typmod changes Postgres proves for free (widening a `varchar`,
dropping its length limit, widening a `numeric` at the same scale) and flags
everything else as a rewrite — including `int -> bigint`, which looks harmless and
rewrites the entire heap. The hazard names the real table size, pulled from
`pg_class`, and describes the shadow-column procedure instead of pretending:

> `orders.customer_id`: integer → bigint rewrites the whole table (5.2 GB / ~48M rows)
> while holding ACCESS EXCLUSIVE. Postgres has no online form of this; on a large
> table do it as a shadow column — add the new column, backfill in batches, swap the
> names.

The alternative was to just emit good SQL and let the user judge. I don't think
that's good enough, because the failure is invisible until it's happening in
production, and by then you can't stop it. Row counts come from `reltuples`, the
planner's estimate — running `count(*)` on a 5GB table to warn someone about a 5GB
table would have been a poor joke.

Both plans are always available; the toggle shows you what the direct version would
have cost.

*Cut:* actually **running** the shadow-column procedure. The planner describes it
and won't do it. Backfilling in bounded batches with dual writes is a genuinely
hard piece of work and the honest version of it doesn't fit in an HTTP request.
It's the first thing I'd build next.

### Types the model doesn't have are kept, not dropped

Real databases have `jsonb`, `uuid`, arrays, enums, domains. The model spells out
seven types. The first version quietly skipped anything else — which meant
introspecting a table with a `jsonb` column produced a schema without it, and the
next diff emitted `DROP COLUMN metadata`. A tool whose whole point is not losing
data, losing data because it didn't recognise a type.

`ColumnType` now has `{ kind: 'other', sql }`, which round-trips the type verbatim.
The column stays in the schema, diffs correctly against itself, survives renames and
constraint changes, and cannot be dropped by accident. What you can't do is change
its type, and `introspect` returns a note saying exactly that, listing the columns
affected.

Same principle for things the *shape* can't hold — a multi-column unique key, a
table-level check. Ignored consistently on both sides of a diff, so they're never
dropped, and reported in the same notes so nobody assumes the tool is managing them.

### The server never runs SQL the browser sends it

`/api/apply` takes the schema you *want*. It does not take SQL, and it does not take
your idea of the current state either — it reads the live database itself, diffs
against that, plans, and runs its own statements. An endpoint that accepted SQL would
be an open query console for every database the deployment can reach.

That was the design from the start. Then on the last day I sat down to actually
attack it and found I'd left the door open anyway — see the hardening section.

Two more guards worth naming. `/api/introspect` returns a `fingerprint` of the
schema; `/api/apply` takes it back as `expect` and returns **409** if the database
has moved since you read it, because a plan computed against a schema that no longer
exists is a guess. And `dryRun` defaults to `true`: writing is opt-in, at the
protocol level, not just in the UI.

### Rehearsal

The button I'm most attached to. *Rehearse* runs every statement for real, against
the real rows, inside a transaction, and then rolls it back.

A migration fails in two interesting places: generating invalid SQL, and meeting
data that doesn't satisfy a new constraint. Static analysis catches the first. Only
actually running it catches the second — and the second is the one that bites, because
it depends on rows nobody has looked at in two years. So:

```
ALTER TABLE "orders" ADD CONSTRAINT "orders_note_not_null" CHECK ("note" IS NOT NULL) NOT VALID;  ok
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_note_not_null";                                  failed
  check constraint "orders_note_not_null" of relation "orders" is violated by some row
```

Two hundred milliseconds, nothing committed, and the constraint that failed is named.
The one thing it can't rehearse is `CREATE INDEX CONCURRENTLY`, because Postgres won't
run it inside a transaction; the result says so per statement rather than quietly
skipping it.

### The dev server ships its own Postgres

`npm install && npm run dev` and the whole product works — read a schema, rehearse,
apply. No container, no connection string, no signup.

With no `DATABASE_URL` set, the dev server starts PGlite (Postgres 18 compiled to
wasm) in-process and seeds it with a small schema shaped like something real: a
foreign key, a composite key, a check constraint, a `jsonb` column the model doesn't
spell out, nullable data that will fail a `NOT NULL`, and about 1200 rows.

The alternative was a `docker-compose.yml` and a line in the README. I've been on the
other side of that too many times. The reviewer who can't be bothered installing
Postgres is exactly the reviewer whose time I have the least right to waste — and
"clone, install, it works" is a decision about respect for the reader as much as
about tooling.

It pays twice: the integration tests run the real read → plan → apply → read-back
cycle against actual Postgres, in CI, with no service container. Eighteen of the 184
tests execute genuine DDL.

### Vercel, and the shape it forces

Static SPA plus two Node functions. It's the least infrastructure that can satisfy
"a URL we can test", and it fits the work: introspect and apply are short, stateless
request/response.

What it forces me to be honest about is duration. A `VALIDATE CONSTRAINT` on a real
5GB table outlasts any HTTP request. The executor carries a deadline, stops cleanly
when it runs out, and reports which statements it never reached and why, rather than
being killed halfway with the client believing it finished. That's honest, not
finished — the real answer is a job queue, which is on the list below.

---

## Day 5, later — measuring instead of assuming

### The changed-line gutter, which I'd hidden behind a memo

The merged schema highlights every line that differs from base. I wrote the textbook
LCS table, and because the parent re-renders on every keystroke, I wrapped it in a
`useMemo` and moved on. The comment I left says `O(lines²) — memoised because the
parent re-renders`.

Memoising was treating the symptom. The cost is O(N×M) in **memory** as well as
time, and I never checked what that meant at the sizes this tool is built for. When
I finally benchmarked it:

| merged schema | matrix | time | heap |
| --- | --- | --- | --- |
| 3,300 lines (25 tables) | 11M | 98 ms | — |
| 8,000 lines | 64M | 1.0 s | 633 MB |
| 16,000 lines | 256M | 3.1 s | 2.0 GB |
| 53,000 lines (200 tables) | 2.8B | — | out of memory, tab dies |

The 98 ms case was already the slowest thing in the app by two orders of magnitude.
Everything past it is a crash — reached by clicking *Read schema* on any real
database. The one component that had nothing to do with the hard part of the problem
was the one that fell over on it.

Three fixes on the table. **Hirschberg** gets memory to O(min(N,M)) and leaves the
time quadratic, so 53,000 lines would still take minutes. **Trimming the common
prefix and suffix** is six lines, and I measured it before believing it: on its own it
does nothing here, because schema edits are scattered rather than contiguous, and
16,000 lines still leaves a 14,668-square middle. **Myers** is O((N+M)·D) in the
number of *differing* lines, and D is tiny for what this is actually used on — a
merged schema differs from its base by dozens of lines, not thousands. It's what
`git diff` uses.

Myers, with the trim in front of it because it costs nothing and does help when a
change is one contiguous block:

| merged schema | before | after |
| --- | --- | --- |
| 3,300 lines | 98 ms | 0.3 ms |
| 53,000 lines | crash | 5.1 ms |
| 316,000 lines (1000 tables) | crash | 62 ms |

Myers keeps an O(D²) trace to reconstruct the path, so two schemas with nothing in
common would trade one unbounded allocation for another. Past 1,000 differing lines
it stops and falls back to a multiset difference — a line is new when the old text
has no unspent copy of it. That ignores ordering, so it's an approximation, but it's
linear, it's exactly right about every line with no counterpart at all, and by the
time a third of the file is highlighted nobody is reading it line by line.

Testing it needed care. Where several shortest edit scripts exist Myers may pick a
different one from the LCS walk and **both are correct**, so asserting an exact set
of line numbers would be testing an implementation detail. The property test asserts
the two things that actually define a right answer — it marks as few lines as
possible (the count equals `after.length` minus the true LCS length, brute-forced),
and the lines it leaves unmarked really do appear in the old text in order — over 300
randomised inputs drawn from a six-letter alphabet so ties are common.

While the profiler was open: six engine calls were sitting in JSX rather than a
`useMemo`, so two diffs, three name lookups and two whole-schema serialisations
re-ran on every render, including on a conflict click that changes none of their
inputs. Memoised. Not a crash, but no reason for it.

### Going looking for holes

The last thing I did was stop building and spend an afternoon trying to break the
API the way an unfriendly reviewer would. Four findings, all now fixed and all with
regression tests.

**Arbitrary SQL through a `CHECK` expression.** The bad one. `check` and `default`
are the only two places a user's own SQL text reaches generated DDL — everything else
is an identifier and gets double-quoted. Expressions can't be, because the point of
them is to be SQL. So this got through:

```json
{ "kind": "check", "expr": "1=1); CREATE TABLE pwned (x int); --" }
```

```sql
ALTER TABLE "orders" ADD CONSTRAINT "orders_id_check" CHECK (1=1); CREATE TABLE pwned (x int); --) NOT VALID;
```

Which makes "the server never runs SQL the browser sends it" a false claim, and on
the hosted demo it's arbitrary SQL against the database the deployment owns.

It's fixed in two independent places, because one of them shouldn't have to be
perfect. **The driver is pinned to the extended query protocol** — `db.query(sql, [])`
with an empty parameter list, which accepts exactly one statement. `pg` uses the
*simple* protocol for a parameterless query, and that one runs `a; b` as two commands
quite happily. (This is also why the bug survived my own testing for a while: PGlite
uses the extended protocol, so the dev database refused the injection and production
would not have.) And **expressions are gated at the input boundary** — no semicolons,
no comment openers, no dollar quoting, no backslash escapes, balanced parentheses,
balanced string literals, 1000-character limit.

What the gate deliberately does *not* do is restrict which functions you can call.
`now()` and `gen_random_uuid()` are most of the reason people write defaults, and an
allowlist would be wrong within a week. So the trust boundary is stated rather than
pretended away: whoever can reach this can evaluate expressions as the connected role.
Give it a role that owns its own schema and nothing else.

**Statements went to the wrong schema.** Generated DDL names tables without
qualifying them, so what they hit is whatever `search_path` resolves to. Read
`analytics`, apply, silently alter `public`. Now every session pins
`search_path` to the schema the request named, using `quote_ident` server-side so the
name never reaches SQL as text, and the schema name itself has to match a strict
pattern.

**Concurrent applies could interleave.** The dev database is one PGlite instance on
one connection shared by every request, so two overlapping applies would interleave
their `BEGIN` and `COMMIT`. Requests are queued there now. Against a real Postgres the
gap was different and worse: read the schema, plan against it, then write — and
another apply landing in that gap means both callers pass the drift check. Apply now
takes a session-scoped `pg_advisory_lock` for the whole request, released when the
connection closes, including if the function is killed mid-request. Five simultaneous
applies of the same change: one 200, four 409s, column created exactly once.

**Unbounded input.** No limit on how big a posted schema could be, and
`detectRenames` compares every unmatched entity against every other. `parseSchema`
now caps tables, total columns, constraints per column, and identifier length — the
last one because Postgres silently truncates identifiers at 63 **bytes**, so two
names differing only past that point become the same object. Measured in bytes, not
characters, which a test pins with a 32-character name that is 96 bytes long.

One thing I looked at and deliberately left alone: a column name containing a double
quote. `q()` doubles it, the payload ends up inside a quoted identifier rather than
beside it, and the result is one inert statement. Rejecting it would have been easy
and would have made the tool unable to read a legitimate database that already
contains one.

---

## What I cut, and why

- **Indexes that aren't constraints.** The most defensible omission to reverse, and
  the one I'd add first. `CREATE INDEX CONCURRENTLY` is already in the executor for
  unique constraints, so the lock story is done; it's the model that would need to
  grow, and I'd rather ship six operations that are right than nine where three are
  half-considered.
- **Views, triggers, functions, sequences, partitions, RLS.** Each is a different
  dependency-ordering problem. Tables and columns are where branch/diff/merge is
  actually interesting.
- **Multi-column unique and foreign keys.** The model attaches constraints per
  column. Composite *primary* keys work, because attaching `primary_key` to each
  member and collapsing at emit time is honest. The same trick doesn't work for a
  composite unique key — `UNIQUE (a, b)` is not `UNIQUE (a)` and `UNIQUE (b)` — so
  rather than fake it, they're read, reported, and left alone.
- **Migration history.** No `schema_migrations` table, no recorded history. The tool
  compares two states and acts; it doesn't remember. That's a real gap for a team
  workflow and the second thing I'd build.
- **Authentication, accounts, saved branches.** Not a product yet. The connection
  string lives in the tab and nowhere else — not in `localStorage`, where a password
  outlives the tab, the session, and the user's memory of typing it.
- **A DDL parser.** Reading `pg_catalog` is a better source of truth than parsing SQL
  text, and it's less work.
- **Down migrations.** Reversing a plan is easy for renames and impossible for drops.
  A half-working undo is worse than none.

## What I'd do next, in order

1. **Backfill orchestration for type changes.** The planner correctly says
   `int -> bigint` rewrites the table and describes the shadow-column procedure. Doing
   it — add column, backfill in bounded batches with a pause between them, dual-write,
   swap the names — is the obvious next hard thing, and the one place the tool
   currently hands you a recipe instead of doing the work.
2. **Long-running steps outside the request.** A `VALIDATE` on a real 5GB table
   outlasts any HTTP request. Reporting what wasn't reached is honest but not
   finished; it wants a job queue.
3. **`lock_timeout` with retry and backoff.** The timeout is set, so a blocked
   statement fails fast instead of queueing production behind it. It doesn't retry
   yet, which is the standard companion to it.
4. **Non-constraint indexes**, then **migration history**, per above.
