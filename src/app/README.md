# app/

The UI. Consumes `@engine`; nothing here is imported back into the engine.

```
main.tsx                 entry
containers/
  MergeWorkbench.tsx     the three schema texts and the conflict picks; derives
                         the diffs, the merge and the plan from them
hooks/
  useDatabase.ts         the live-database half: connect, introspect, apply
components/              presentational — props in, callbacks out
  SchemaEditor           one JSON textarea + inline error
  ChangeList             a Change[] via describeChange, +/−/~ colour-coded
  ConflictResolver       one card per Conflict; a radio group, not two buttons
  DatabasePanel          connection form, table sizes, what isn't managed
  PlanView               the annotated statement list and its hazards
  ApplyPanel             lock-safe toggle, rehearse / apply, the outcome
  CodeBlock              JSON / SQL token colouring; JSON can flag the lines
                         that differ from a baseline
  Section                titled panel card
lib/
  api                    fetch wrappers for /api/introspect and /api/apply
  schemaIO               editor text ↔ Schema (the checks live in the engine)
  describe               ids → names, Change/Conflict → readable strings
fixtures/
styles/
```

State is split in two on purpose. `MergeWorkbench` owns the merge; `useDatabase`
owns the connection. They fail in completely different ways — a merge conflict is
something to resolve, a dropped connection is something to retry — and mixing
them made both harder to follow.

Everything else is derived per render. There is no Run button: edit a pane and the
diffs, the merge, the conflict cards, the merged schema and the plan all
recompute.

Change descriptions and the name lookup live here rather than in the engine —
they're rendering. `styles/index.css` is one file of CSS custom properties and
follows `prefers-color-scheme`.
