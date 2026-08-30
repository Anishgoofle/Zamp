# Schema Version Control

Git, but for database schemas. Create a schema, branch it, evolve each branch
independently (add/drop/rename/retype columns, change constraints/indexes,
create/drop tables), see exactly what diverged, and merge back with conflict
handling. Row data is out of scope — the schema itself is the versioned artifact.

## Architecture

```
src/
  engine/    pure functions, no React: types, diff, merge, rename detection
  app/       UI, consumes engine output
tests/       engine tests
decisions.md running log of real decisions + tradeoffs
```

The boundary is strict: the moment `engine/` imports from `app/`, the engine
stops being exhaustively testable without rendering. Import aliases (`@engine`,
`@app`) keep that boundary visible at call sites.

## Develop

```bash
npm install
npm run dev        # Vite dev server
npm test           # Vitest, single run
npm run test:watch # Vitest, watch mode
npm run build      # tsc -b && vite build
```

Requires Node 20+.

## Deploy

Vercel, framework preset "Vite" — build command and output directory come from
the preset defaults, no config file needed. Add a `vercel.json` rewrite rule
once client-side routing needs deep links to resolve.
