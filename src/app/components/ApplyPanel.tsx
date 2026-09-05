import { useState } from 'react';
import type { Plan, TableStats } from '@engine';
import type { ApplyResponse } from '../lib/api';
import { PlanView } from './PlanView';

/**
 * Run a plan against the connected database. Two buttons on purpose: the rehearsal
 * runs every statement for real inside a transaction and rolls it back, so you can
 * find out whether the migration survives the actual rows before committing to it.
 */
export function ApplyPanel({
  plan,
  stats,
  online,
  onOnlineChange,
  connected,
  source,
  busy,
  outcome,
  error,
  onRun,
}: {
  plan: Plan;
  stats: Record<string, TableStats>;
  online: boolean;
  onOnlineChange: (next: boolean) => void;
  connected: boolean;
  /** Which database this would run against, named without credentials. */
  source: string | null;
  busy: boolean;
  outcome: ApplyResponse | null;
  error: string | null;
  onRun: (dryRun: boolean) => void;
}) {
  // View state, not app state: whether the confirm step is showing.
  const [confirming, setConfirming] = useState(false);
  const blocked = plan.hazards.some((h) => h.severity === 'blocked');
  const empty = plan.steps.length === 0;
  const rehearsed = outcome?.dryRun === true && outcome.results.every((r) => r.status !== 'failed');
  const destructive = plan.steps.filter((step) => step.destructive);

  return (
    <div className="apply">
      <div className="apply-controls">
        <label className="toggle">
          <input
            type="checkbox"
            checked={online}
            onChange={(e) => onOnlineChange(e.target.checked)}
          />
          <span>
            Lock-safe plan
            <span className="muted">
              {' '}
              — decompose the statements that would hold the table
            </span>
          </span>
        </label>
        <div className="apply-buttons">
          <button
            type="button"
            className="ghost"
            disabled={busy || !connected || empty}
            onClick={() => {
              setConfirming(false);
              onRun(true);
            }}
          >
            {busy ? 'Working…' : 'Rehearse (rolls back)'}
          </button>
          <button
            type="button"
            disabled={busy || blocked || !connected || empty || confirming}
            onClick={() => setConfirming(true)}
          >
            Apply for real
          </button>
        </div>
      </div>

      {/* Two steps, because the first one is irreversible and it should not be the
          same single click as the rehearsal next to it. The thing worth naming is
          the *database*: where a deployment allows a connection string from the
          browser, "which one am I about to alter" is the question nobody asks
          until afterwards. */}
      {confirming && (
        <div className="confirm">
          <p>
            Run <strong>{plan.steps.length}</strong> statement{plan.steps.length === 1 ? '' : 's'}{' '}
            against <strong>{source ?? 'the connected database'}</strong>.
          </p>
          {destructive.length > 0 && (
            <p className="confirm-destructive">
              {destructive.length === 1 ? 'One of them discards' : `${destructive.length} of them discard`}{' '}
              data and cannot be undone: {destructive.map((step) => step.intent).join(', ')}.
            </p>
          )}
          {!rehearsed && (
            <p className="muted">
              This hasn't been rehearsed. Rehearsing runs the same statements against the real rows
              and rolls them back — the cheapest way to find out it fails.
            </p>
          )}
          <div className="apply-buttons">
            <button type="button" className="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setConfirming(false);
                onRun(false);
              }}
            >
              Yes, apply to {source ?? 'the database'}
            </button>
          </div>
        </div>
      )}

      {!connected ? (
        <p className="muted">Connect a database above to rehearse and apply this.</p>
      ) : (
        blocked && (
          <p className="muted">
            Applying is disabled while the plan has a statement Postgres will reject.
          </p>
        )
      )}

      {error && <div className="notice error">{error}</div>}

      <PlanView plan={plan} stats={stats} results={outcome?.results} />

      {outcome && outcome.results.length > 0 && <Outcome outcome={outcome} rehearsed={rehearsed} />}
    </div>
  );
}

function Outcome({ outcome, rehearsed }: { outcome: ApplyResponse; rehearsed: boolean }) {
  const failed = outcome.results.find((r) => r.status === 'failed');

  return (
    <div className={failed ? 'notice error' : 'notice ok-notice'}>
      {failed ? (
        <>
          <strong>Stopped at statement {outcome.results.indexOf(failed) + 1}.</strong> {failed.error}
          {!outcome.dryRun && ' Everything in that transaction was rolled back.'}
        </>
      ) : outcome.dryRun ? (
        <>
          <strong>Rehearsal passed.</strong> All {outcome.applied} statement(s) ran against the real
          rows and were rolled back. {rehearsed && 'Nothing was kept — apply for real when ready.'}
        </>
      ) : (
        <>
          <strong>Applied.</strong> {outcome.applied} statement(s) committed. The database now reads
          back as fingerprint <code>{outcome.fingerprint}</code>.
        </>
      )}

      {outcome.renames.length > 0 && (
        <>
          <p>
            The target didn't share ids with the live database, so these were matched up rather than
            dropped and recreated:
          </p>
          <ul>
            {outcome.renames.map((r, i) => (
              <li key={i}>
                {r.from} → {r.to} <span className="muted">(matched by {r.by})</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
