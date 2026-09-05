# Schema Version Control

Branch a Postgres schema, evolve each branch, merge them back — then apply the
result to the real database, with every statement labelled by what it locks and
for how long.

**Who it's for:** someone who owns a Postgres database with real data in it, on a
team where more than one person changes the schema. Two problems, usually treated as
unrelated — reconciling two branches that both touched the schema, and knowing
whether the resulting migration will take production down. `ALTER TABLE ... SET NOT
NULL` is one line and reads like nothing; on a 5GB table it holds an exclusive lock
across a full scan and your connection pool is gone in forty seconds.

The merge is the feature. The part I went deep on is what happens when the table
you're migrating has 5GB in it: a rename that degrades to drop-and-recreate
destroys the table, and `ALTER TABLE ... SET NOT NULL` takes it offline for
minutes. Both are easy to ship without noticing. See [decisions.md](decisions.md).

## Run it

```bash
git clone <this repo> && cd Zamp
npm install          # Node 20+
npm run dev          # → http://localhost:5173
```

That's the whole setup. **There is no database to install.** With no
`DATABASE_URL` configured the dev server starts its own Postgres — PGlite,
compiled to wasm, running in-process — seeded with a small schema and about
1200 rows, so *Read schema* and *Apply for real* work the moment the page opens.

To point it at your own database instead, put a URL in `.env`:

```bash
cp .env.example .env    # then set DATABASE_URL
```

Any Postgres 12 or later. It only needs to read `pg_catalog` and run DDL; use a
scratch database, because *Apply for real* means it.

## What you can do with it

The page opens on a worked example — a `base` schema with two branches already
diverged.

1. **Read a schema.** *Read schema* in the Database panel introspects the live
   database: tables, columns, types, constraints, and the real size of each table.
   *Branch from this schema* loads it into all three editors.
2. **Evolve the branches.** The three panes are the schemas as JSON. Add a column,
   rename one, retype it, change a constraint, create or drop a table. Everything
   below recomputes as you type; a syntax error pauses the pipeline and shows the
   message inline.
3. **Read the two diffs.** `base → ours` and `base → theirs`. `+` added, `−`
   dropped, `~` renamed / retyped / nullability changed.
4. **Merge.** Non-conflicting changes from both branches are applied
   automatically. Anything both branches touched differently becomes a conflict
   card — take ours or take theirs, one at a time.
5. **Read the plan.** Every statement carries a badge:

   | badge | what it means |
   | --- | --- |
   | `instant` | catalog-only. Safe on a table of any size. |
   | `online` | may run for minutes, but reads and writes keep working. |
   | `blocks the table` | exclusive lock held across a full scan or rewrite. |

   With **Lock-safe plan** on (the default), the statements that would block get
   decomposed into forms that don't. Turn it off to see the textbook DDL and what
   it would have cost.

6. **Rehearse.** Runs every statement against the real rows inside a transaction,
   then rolls back. This is how you find out that your new `NOT NULL` has 43 rows
   that violate it — in 200ms, instead of at 3am.
7. **Apply for real.**

*Reset to example* restores the starting scenario. The UI follows your OS
light/dark setting.

### Try the interesting bit

With the dev database running, in the `ours` pane:

- Rename `customers.email` → `customers.email_address`. One instant statement.
  Now compare: that's a rename because ids come from `pg_catalog`, not from us.
  Without that, it would be `DROP TABLE` + `CREATE TABLE`.
- Set `orders.note` to `"nullable": false`. Watch the lock-safe plan turn one
  blocking statement into four that don't block — then *Rehearse* it and watch the
  real rows reject it, naming the constraint.
- Change `orders.customer_id` from `int` to `bigint`. Postgres has no online form
  of this; the hazard says so, says how big the table is, and describes the
  shadow-column procedure rather than pretending.
- Add a column with `"nullable": false` and no default. Apply is disabled — that
  statement cannot succeed on a table with rows in it.

### Try to break it

Please do. These are the things I went after myself, and what should happen — all
of them have regression tests in `tests/engine/hardening.test.ts`.

| what you try | what happens |
| --- | --- |
| SQL in a `check` or `default` expression — `1=1); DROP TABLE customers; --` | 400 at the input boundary, naming the character it objected to. The driver is also pinned to the extended query protocol, so one call is one statement even if something gets past the check. |
| A comment (`--`, `/*`), dollar quoting (`$$`), an unbalanced paren or an unterminated string | 400. Each would let an expression escape the `CHECK (...)` around it. |
| A column named `a" ; DROP TABLE customers; --` | Accepted, and inert. The quote is doubled, so the payload is *inside* a quoted identifier: one statement, one absurdly named column. Real databases contain odd names and this tool has to be able to read them. |
| A 200-character table name | 400. Postgres truncates identifiers at 63 **bytes**, and two names that differ past that become the same object. Measured in bytes, so 32 CJK characters is also rejected. |
| A schema with 5,000 tables | 400. Bounded at 2,000 tables / 20,000 columns, because `detectRenames` compares every unmatched entity against every other. |
| `{"schema": "public\"; DROP SCHEMA public CASCADE; --"}` | 400. Schema names must match a strict pattern, and the search path is set with `quote_ident` server-side. |
| Introspect schema `a`, apply, expect it to hit `public` | It doesn't. Every session pins `search_path` to the schema the request named. |
| Five simultaneous applies of the same change | One 200, four 409s, column created exactly once. Apply holds a `pg_advisory_lock` and re-checks the schema fingerprint. |
| Two different concurrent changes from the same base | One lands, the other gets 409 and is told to re-read. No lost update. |
| Apply, then apply the same target again | Zero statements. The plan is derived from the live database each time, so it converges. |
| `__proto__` in the posted JSON | Ignored. `Object.prototype` stays clean. |
| Malformed JSON, `GET` instead of `POST`, no `target` | 400 / 405 / 400, with a message rather than a stack trace. |
| A 60,000-line schema in the merged-schema view | Diffs in about 5 ms. This used to take the tab out with an OOM; see `decisions.md`. |
| Point it at a database and add a `NOT NULL` column with no default | Apply is disabled. That statement cannot succeed on a table with rows in it. |

Two things that are *not* defended, on purpose, and are documented rather than
pretended away:

- **An expression can call any function the connected role can call.** Restricting
  that would mean an allowlist, and `now()` / `gen_random_uuid()` are most of the
  reason people write defaults. Point this at a role that owns its own schema and
  nothing else.
- **`ALLOW_CLIENT_DATABASE_URL=true` lets the browser name any host.** That is the
  point of it, and it is off by default.

## Deploy

Vercel, no configuration beyond environment variables. [`vercel.json`](vercel.json)
sets the framework preset and the function timeouts.

```bash
npm i -g vercel
vercel            # link the project
vercel --prod
```

Then set, under **Settings → Environment Variables**:

| variable | |
| --- | --- |
| `DATABASE_URL` | the Postgres this deployment owns. Neon's free tier is the quickest way to get one. Use the **direct** connection string, not the pooled one. |
| `ALLOW_CLIENT_DATABASE_URL` | `true` to let the browser supply its own connection string. Off by default. |

**Not the pooled endpoint.** Neon and Supabase both show you a pooled connection
string by default (Neon puts `-pooler` in the hostname). This tool keeps state on
the connection between round-trips: two timeouts, a pinned `search_path`, and an
advisory lock held from the read through to the write. A transaction-mode pooler
can hand each statement to a different backend and silently drops all three, so
`/api/apply` refuses one with a 400 rather than running unprotected. Use the
direct string: on Neon, the same host with `-pooler` removed.

Then seed it, or the deployment comes up pointing at an empty database and
"Read schema" returns nothing:

```bash
DATABASE_URL='postgres://...' npm run seed
```

That creates the same three demo tables `npm run dev` uses, with a thousand rows
in `orders` so a failing constraint has something to fail on. It refuses to touch
a database holding tables it doesn't recognise, so a mistyped URL can't cost you
a schema.

`ALLOW_CLIENT_DATABASE_URL` is off unless you turn it on: an endpoint that dials
whatever address a browser hands it is a port scanner with a public URL. Turn it
on for a scratch deployment you want other people to point at their own database,
and only then.

The build is a static SPA plus two Node functions. Nothing is stored server-side;
connection strings live for the length of one request and are never logged.

## API

Two endpoints. The browser sends the schema it *wants*, never SQL — the server
reads the live database itself, diffs against that, and runs only statements this
engine generated.

```
POST /api/introspect  { connectionString?, schema? }
                    → { schema, stats, notes, fingerprint, source }

POST /api/apply       { connectionString?, schema?, target, online?, dryRun?, expect? }
                    → { plan, results, applied, renames, fingerprint, schema, stats }
```

`expect` is the fingerprint the plan was built against; `/api/apply` returns 409
if the database has moved since. `dryRun` defaults to `true` — writing is opt-in.

## Layout

```
src/engine/     the whole thing, with no React in it
  model/        plain data: Schema → Table → Column, and the Change union
  operations/   diff · apply · branch · validate · merge · detectRenames · plan · introspect
  postgres/     catalog reads and the executor, behind an injected `Queryable`
src/app/        the workbench — containers hold state, components are pure
api/            three thin Vercel functions: HTTP, connection, policy
tests/engine/   pure unit tests
tests/app/      the line diff behind the changed-line gutter
tests/postgres/ the real read → plan → apply → read-back cycle, against Postgres 18
```

The engine is the interesting part and is tested on its own. The `@engine` /
`@app` aliases keep the boundary visible at call sites.
[`src/engine/README.md`](src/engine/README.md) and
[`src/app/README.md`](src/app/README.md) have the per-module maps.

## Scripts

```bash
npm run dev         # Vite + the api routes + a seeded in-process Postgres
npm test            # 184 tests, including 18 against real Postgres
npm run test:watch
npm run seed        # put the demo schema into a real DATABASE_URL
npm run typecheck   # tsc -b --noEmit across app, api and tooling
npm run build       # → dist/
npm run preview     # serve the built dist/ (no api routes — use `vercel dev`)
```
