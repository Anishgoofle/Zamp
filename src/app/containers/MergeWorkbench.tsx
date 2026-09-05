import { useMemo, useState } from 'react';
import { diff, merge, plan, resolveMerge } from '@engine';
import type { Conflict, Schema } from '@engine';
import { ApplyPanel } from '../components/ApplyPanel';
import { ChangeList } from '../components/ChangeList';
import { CodeBlock } from '../components/CodeBlock';
import { ConflictResolver } from '../components/ConflictResolver';
import { DatabasePanel } from '../components/DatabasePanel';
import { SchemaEditor } from '../components/SchemaEditor';
import { Section } from '../components/Section';
import * as example from '../fixtures/exampleSchemas';
import { useDatabase } from '../hooks/useDatabase';
import { makeNames } from '../lib/describe';
import { parseSchema, serializeSchema } from '../lib/schemaIO';

type Side = 'ours' | 'theirs';

/** Stable identity, so the memos keyed on `conflicts` hold while there is no merge. */
const NO_CONFLICTS: readonly Conflict[] = [];

/**
 * A pick belongs to a conflict *and* to the two sides it was choosing between.
 * Conflict ids are location-only, so keying on the id alone would silently carry
 * a choice over to a differently-valued conflict in the same slot after an edit.
 */
function pickKey(conflict: Conflict): string {
  return [conflict.id, JSON.stringify(conflict.ours), JSON.stringify(conflict.theirs)].join('|');
}

/** Owns the three editable schemas and the conflict picks; everything else is derived per render. */
export function MergeWorkbench() {
  const [baseText, setBaseText] = useState(() => serializeSchema(example.base));
  const [oursText, setOursText] = useState(() => serializeSchema(example.ours));
  const [theirsText, setTheirsText] = useState(() => serializeSchema(example.theirs));
  const [picks, setPicks] = useState<Record<string, Side>>({});
  const [online, setOnline] = useState(true);
  const db = useDatabase();

  const base = useMemo(() => parseSchema(baseText), [baseText]);
  const ours = useMemo(() => parseSchema(oursText), [oursText]);
  const theirs = useMemo(() => parseSchema(theirsText), [theirsText]);

  const merged = useMemo(() => {
    if (!base.schema || !ours.schema || !theirs.schema) return null;
    try {
      return { result: merge(base.schema, ours.schema, theirs.schema), error: null };
    } catch (e) {
      return { result: null, error: (e as Error).message };
    }
  }, [base.schema, ours.schema, theirs.schema]);

  const result = merged?.result ?? null;
  const conflicts = result?.conflicts ?? NO_CONFLICTS;
  // `pickKey` stringifies both sides of every conflict, so this is not free at
  // 200 tables — and it would otherwise re-run on every keystroke and every pick.
  const unresolved = useMemo(
    () => conflicts.filter((c) => !picks[pickKey(c)]),
    [conflicts, picks],
  );

  /** `picks` keyed the way `resolveMerge` and the conflict cards want it. */
  const picksById = useMemo(() => {
    const byId: Record<string, Side> = {};
    for (const conflict of conflicts) {
      const side = picks[pickKey(conflict)];
      if (side) byId[conflict.id] = side;
    }
    return byId;
  }, [conflicts, picks]);

  const resolved = useMemo(() => {
    if (!result || unresolved.length > 0) return null;
    try {
      return { ...resolveMerge(result, picksById), error: null };
    } catch (e) {
      return { schema: null, errors: [], error: (e as Error).message };
    }
  }, [result, picksById, unresolved.length]);

  // No fallback to `result.schema`: that is the *pre*-resolution merge, with
  // conflicted slots still at their base values. Showing it as the final schema
  // would silently discard the user's picks.
  const finalSchema = resolved?.schema ?? null;
  const finalErrors = resolved?.errors ?? [];
  const invalid = finalErrors.length > 0;

  // Sizes from the connected database, so "this rewrites the table" can say how
  // big the table is. Ids have to line up: once `base` has been edited into a
  // different database's schema, the live sizes describe something else.
  const live = db.live;
  const stats = useMemo(() => {
    if (!live || !base.schema) return {};
    const liveIds = new Set(live.schema.tables.map((t) => t.id));
    return base.schema.tables.some((t) => liveIds.has(t.id)) ? live.stats : {};
  }, [live, base.schema]);

  const migration = useMemo(() => {
    if (!base.schema || !finalSchema) return null;
    try {
      return {
        plan: plan(base.schema, diff(base.schema, finalSchema), { online, stats }),
        error: null,
      };
    } catch (e) {
      return { plan: null, error: (e as Error).message };
    }
  }, [base.schema, finalSchema, online, stats]);

  const oursDiff = useMemo(
    () => (base.schema && ours.schema ? diff(base.schema, ours.schema) : []),
    [base.schema, ours.schema],
  );
  const theirsDiff = useMemo(
    () => (base.schema && theirs.schema ? diff(base.schema, theirs.schema) : []),
    [base.schema, theirs.schema],
  );
  const oursNames = useMemo(() => makeNames(ours.schema, base.schema), [ours.schema, base.schema]);
  const theirsNames = useMemo(
    () => makeNames(theirs.schema, base.schema),
    [theirs.schema, base.schema],
  );
  const names = useMemo(
    () => makeNames(finalSchema, ours.schema, theirs.schema, base.schema),
    [finalSchema, ours.schema, theirs.schema, base.schema],
  );

  // Serialising the whole schema twice per render is the single most expensive
  // thing left on this path once the branch diffs are memoised.
  const mergedJson = useMemo(() => (finalSchema ? serializeSchema(finalSchema) : ''), [finalSchema]);
  const baseJson = useMemo(() => (base.schema ? serializeSchema(base.schema) : ''), [base.schema]);

  const loadSchema = (schema: Schema) => {
    const text = serializeSchema(schema);
    setBaseText(text);
    setOursText(text);
    setTheirsText(text);
    setPicks({});
  };

  const reset = () => {
    setBaseText(serializeSchema(example.base));
    setOursText(serializeSchema(example.ours));
    setTheirsText(serializeSchema(example.theirs));
    setPicks({});
  };

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Schema Version Control</h1>
          <p className="muted">
            Branch a Postgres schema, evolve each branch, merge them back, and apply the result to
            the real database with every statement labelled by what it locks and for how long.
          </p>
        </div>
        <button type="button" className="ghost" onClick={reset}>
          Reset to example
        </button>
      </header>

      <Section
        title="Database"
        aside={db.live && <span className="tag pick-tag">{db.live.schema.tables.length} tables</span>}
      >
        <DatabasePanel
          connection={db.connection}
          onChange={db.setConnection}
          live={db.live}
          busy={db.busy === 'reading'}
          error={db.busy === 'applying' ? null : db.error}
          onRead={db.read}
          onUseAsBase={loadSchema}
          onDisconnect={db.disconnect}
        />
      </Section>

      <section className="editors">
        <SchemaEditor label="base" text={baseText} onChange={setBaseText} error={base.error} />
        <SchemaEditor label="ours" text={oursText} onChange={setOursText} error={ours.error} />
        <SchemaEditor label="theirs" text={theirsText} onChange={setTheirsText} error={theirs.error} />
      </section>

      {!result || !base.schema || !ours.schema || !theirs.schema ? (
        <p className="notice">
          {merged?.error
            ? `Merge failed: ${merged.error}`
            : 'Fix the schema error(s) above to see the diff and merge.'}
        </p>
      ) : (
        <>
          <p className="legend">
            <span data-sign="add">+ added</span>
            <span data-sign="drop">− dropped</span>
            <span data-sign="modify">~ renamed / retyped / nullability</span>
          </p>

          <section className="panel two-col">
            <div>
              <h3>base → ours</h3>
              <ChangeList
                changes={oursDiff}
                names={oursNames}
                empty="No changes."
              />
            </div>
            <div>
              <h3>base → theirs</h3>
              <ChangeList
                changes={theirsDiff}
                names={theirsNames}
                empty="No changes."
              />
            </div>
          </section>

          <Section title="Auto-merged">
            <ChangeList changes={result.changes} names={names} empty="Nothing applied automatically." />
          </Section>

          <Section
            title="Conflicts"
            aside={
              conflicts.length > 0 && (
                <span className="tag">
                  {conflicts.length - unresolved.length}/{conflicts.length} resolved
                </span>
              )
            }
          >
            <ConflictResolver
              conflicts={conflicts}
              picks={picksById}
              onPick={(conflict, side) =>
                setPicks((prev) => ({ ...prev, [pickKey(conflict)]: side }))
              }
              names={names}
            />
          </Section>

          <Section title="Merged schema">
            {unresolved.length > 0 ? (
              <p className="muted">
                Resolve the {unresolved.length} conflict(s) above to see the merged schema.
              </p>
            ) : resolved?.error ? (
              <div className="notice error">Could not apply the resolution: {resolved.error}</div>
            ) : (
              <>
                {invalid ? (
                  <div className="notice">
                    Merged, but the result is invalid:
                    <ul>
                      {finalErrors.map((e, i) => (
                        <li key={i}>{e.message}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="ok">Valid.</p>
                )}
                {finalSchema && (
                  <>
                    <p className="muted code-caption">Highlighted lines differ from base.</p>
                    <CodeBlock
                      lang="json"
                      code={mergedJson}
                      baseline={baseJson}
                    />
                  </>
                )}
              </>
            )}
          </Section>

          <Section
            title="Migration"
            aside={
              migration?.plan && (
                <span className="tag">{online ? 'lock-safe' : 'direct'}</span>
              )
            }
          >
            {unresolved.length > 0 ? (
              <p className="muted">Resolve all conflicts to generate the migration.</p>
            ) : resolved?.error ? (
              <p className="muted">No migration — the resolution above could not be applied.</p>
            ) : invalid ? (
              <p className="muted">
                No migration — the merged schema is invalid, so any DDL for it would not run.
              </p>
            ) : migration?.error ? (
              <div className="notice error">Could not generate the migration: {migration.error}</div>
            ) : migration?.plan ? (
              <ApplyPanel
                plan={migration.plan}
                stats={stats}
                online={online}
                onOnlineChange={setOnline}
                connected={live !== null}
                source={live?.source ?? null}
                busy={db.busy === 'applying'}
                outcome={db.outcome}
                error={db.busy === 'reading' ? null : db.error}
                onRun={(dryRun) => finalSchema && db.apply(finalSchema, { online, dryRun })}
              />
            ) : null}
          </Section>
        </>
      )}
    </main>
  );
}
