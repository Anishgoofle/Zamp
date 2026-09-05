import type { Hazard, LockLevel, Plan, Step, TableStats } from '@engine';
import type { StepResult } from '../lib/api';
import { formatBytes } from '../lib/format';

/** What each lock level means for the people using the table while the statement runs. */
const LOCK: Record<LockLevel, { label: string; title: string }> = {
  instant: {
    label: 'instant',
    title: 'Catalog-only. Takes an exclusive lock for microseconds — safe at any table size.',
  },
  concurrent: {
    label: 'online',
    title: 'Reads every row and may run for a while, but takes only a weak lock — queries keep working.',
  },
  blocking: {
    label: 'blocks the table',
    title: 'Holds ACCESS EXCLUSIVE across a full scan or rewrite. Every query on the table waits.',
  },
};

const STATUS = { ok: '✓', failed: '✗', skipped: '·' } as const;

export function PlanView({
  plan,
  stats,
  results,
}: {
  plan: Plan;
  stats?: Record<string, TableStats> | undefined;
  /** Present once the plan has been run: per-statement outcome, positionally aligned. */
  results?: readonly StepResult[] | undefined;
}) {
  if (plan.steps.length === 0) {
    return <p className="muted">No statements — the database already matches this schema.</p>;
  }
  const worst = worstLock(plan.steps);
  return (
    <>
      <HazardList hazards={plan.hazards} />
      <p className="plan-summary">
        {plan.steps.length} statement{plan.steps.length === 1 ? '' : 's'} ·{' '}
        <span data-lock={worst}>{LOCK[worst].label}</span>
        {worst !== 'blocking' && ' — safe to run against a table with data in it'}
      </p>
      <ol className="plan">
        {plan.steps.map((step, i) => (
          <StepRow key={i} step={step} stats={stats} result={results?.[i]} />
        ))}
      </ol>
    </>
  );
}

function StepRow({
  step,
  stats,
  result,
}: {
  step: Step;
  stats: Record<string, TableStats> | undefined;
  result: StepResult | undefined;
}) {
  const size = step.tableId ? stats?.[step.tableId] : undefined;
  return (
    <li className="plan-step" data-status={result?.status}>
      <div className="plan-step-head">
        {result && <span className="plan-status">{STATUS[result.status]}</span>}
        <span className="plan-intent">{step.intent}</span>
        <span className="badge" data-lock={step.lock} title={LOCK[step.lock].title}>
          {LOCK[step.lock].label}
        </span>
        {step.rewrites && size && (
          <span className="badge" data-lock="blocking" title="Postgres writes a new copy of every row.">
            rewrites {formatBytes(size.bytes)}
          </span>
        )}
        {step.scans && !step.rewrites && size && (
          <span className="badge" title="Postgres reads every row.">
            scans {formatBytes(size.bytes)}
          </span>
        )}
        {!step.runsInTransaction && (
          <span className="badge" title="Postgres refuses to run this inside a transaction.">
            not in a transaction
          </span>
        )}
        {result && result.status === 'ok' && <span className="plan-ms">{result.ms} ms</span>}
      </div>
      <pre className="plan-sql">{step.sql}</pre>
      {result?.error && <p className="plan-error">{result.error}</p>}
    </li>
  );
}

function HazardList({ hazards }: { hazards: readonly Hazard[] }) {
  if (hazards.length === 0) return null;
  return (
    <ul className="hazards">
      {hazards.map((hazard, i) => (
        <li key={i} data-severity={hazard.severity}>
          <strong>{hazard.severity === 'blocked' ? "Won't run" : 'Heads up'}</strong> {hazard.message}
        </li>
      ))}
    </ul>
  );
}

function worstLock(steps: readonly Step[]): LockLevel {
  if (steps.some((s) => s.lock === 'blocking')) return 'blocking';
  if (steps.some((s) => s.lock === 'concurrent')) return 'concurrent';
  return 'instant';
}
