# engine/

Pure TypeScript. **Zero React imports.** Data in, data out.

Planned modules (written by hand, not scaffolded):

- `types.ts` — schema model: tables → columns, each with a stable `id` separate from `name`.
- `diff.ts` — `diff(before, after)` → one flat, deterministically ordered array of granular change objects.
- `rename.ts` — rename detection.
- `merge.ts` — three-way merge with conflict detection.

If anything here imports from `../app`, the testability property is lost. Don't cross the boundary.
