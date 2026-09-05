import { batches } from '../operations/plan.js';
import type { Step } from '../operations/plan.js';
import type { Queryable } from './catalog.js';

export interface StepResult {
  sql: string;
  status: 'ok' | 'failed' | 'skipped';
  ms: number;
  error?: string;
}

export interface RunOptions {
  /** Stop and report rather than start a statement after this moment. */
  deadline?: number;
}

/**
 * Run the plan for real, then throw it away.
 *
 * Migrations fail in two interesting ways: invalid SQL, and data that doesn't
 * satisfy a new constraint. Both show up here, because the statements really run
 * against the real rows, and the ROLLBACK at the end means finding out is free.
 * CREATE INDEX CONCURRENTLY is the exception; Postgres won't run it inside a
 * transaction, so it can't be rehearsed.
 */
export async function rehearse(
  db: Queryable,
  steps: readonly Step[],
  options: RunOptions = {},
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  await db.query('BEGIN');
  try {
    for (const step of steps) {
      if (!step.runsInTransaction) {
        results.push({
          sql: step.sql,
          status: 'skipped',
          ms: 0,
          error: 'cannot run inside a transaction, so it cannot be rehearsed',
        });
        continue;
      }
      const outcome = await runStep(db, step, options);
      results.push(outcome);
      if (outcome.status === 'failed') break;
    }
  } finally {
    await db.query('ROLLBACK').catch(() => {});
  }
  return fill(results, steps);
}

/**
 * Run the plan and keep it. Statements that can share a transaction do, so a
 * failure takes its whole batch back out. CREATE INDEX CONCURRENTLY has to stand
 * alone, which is why a plan containing one isn't all-or-nothing. `plan` reports
 * that as a hazard.
 */
export async function execute(
  db: Queryable,
  steps: readonly Step[],
  options: RunOptions = {},
): Promise<StepResult[]> {
  const results: StepResult[] = [];

  for (const batch of batches(steps)) {
    const startOfBatch = results.length;
    if (batch.runsInTransaction) await db.query('BEGIN');

    let failed = false;
    for (const step of batch.steps) {
      const outcome = await runStep(db, step, options);
      results.push(outcome);
      if (outcome.status !== 'ok') {
        failed = true;
        break;
      }
    }

    if (batch.runsInTransaction) {
      await db.query(failed ? 'ROLLBACK' : 'COMMIT').catch(() => {});
      // A rolled-back batch did not happen. Reporting "ok" for statements the
      // database no longer remembers would send someone debugging the wrong thing.
      if (failed) {
        for (let i = startOfBatch; i < results.length; i++) {
          if (results[i]!.status === 'ok') results[i]!.status = 'skipped';
        }
      }
    }
    if (failed) break;
  }

  return fill(results, steps);
}

async function runStep(db: Queryable, step: Step, options: RunOptions): Promise<StepResult> {
  if (options.deadline !== undefined && Date.now() >= options.deadline) {
    return {
      sql: step.sql,
      status: 'skipped',
      ms: 0,
      error:
        'out of time. A VALIDATE or an index build on a large table outlasts any HTTP request — ' +
        'run the rest of the plan from a shell.',
    };
  }
  const started = Date.now();
  try {
    // The empty parameter list is load-bearing. Without it pg uses the simple
    // query protocol, which will happily run `a; DROP TABLE b` as two commands.
    // With it the driver uses the extended protocol, which takes exactly one.
    // Nothing here is ever more than one statement, so letting the driver enforce
    // that is free and closes statement stacking whatever slips past parseSchema.
    await db.query(step.sql, []);
    return { sql: step.sql, status: 'ok', ms: Date.now() - started };
  } catch (e) {
    return { sql: step.sql, status: 'failed', ms: Date.now() - started, error: describeError(e) };
  }
}

/** Everything the run never reached, so the report still covers the whole plan. */
function fill(results: StepResult[], steps: readonly Step[]): StepResult[] {
  for (let i = results.length; i < steps.length; i++) {
    results.push({ sql: steps[i]!.sql, status: 'skipped', ms: 0 });
  }
  return results;
}

/**
 * A Postgres error carries more than a message: the constraint that failed, the
 * offending row, the hint. Dropping those turns "check constraint
 * users_email_not_null is violated by some row" into "error".
 */
function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const pg = e as Error & { detail?: string; hint?: string };
  return [pg.message, pg.detail, pg.hint].filter(Boolean).join(' — ');
}
