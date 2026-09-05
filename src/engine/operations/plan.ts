import { apply } from './apply.js';
import type { Change } from '../model/change.js';
import type { Column, ColumnConstraint, ColumnType, Schema, Table } from '../model/types.js';

/**
 * What a statement costs everyone else using the table while it runs.
 *
 * instant     catalog-only. ACCESS EXCLUSIVE for microseconds. Safe at any size.
 * concurrent  can run for minutes but only takes SHARE UPDATE EXCLUSIVE, so reads
 *             and writes keep working.
 * blocking    holds ACCESS EXCLUSIVE across a full scan or a heap rewrite. Every
 *             query on the table queues behind it. This is the outage case.
 */
export type LockLevel = 'instant' | 'concurrent' | 'blocking';

export interface Step {
  sql: string;
  /** One line on why this statement exists. Shown next to it in the UI. */
  intent: string;
  lock: LockLevel;
  /** Postgres reads every row (`VALIDATE CONSTRAINT`, an index build). */
  scans: boolean;
  /** Postgres writes a new copy of every row. Costs table size, plus disk for both. */
  rewrites: boolean;
  /** `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. */
  runsInTransaction: boolean;
  /** The table this touches, for pulling in live size stats. */
  tableId: string | null;
  /** Discards data. Instant and irreversible, so the UI confirms before running it. */
  destructive: boolean;
}

export interface Hazard {
  /** `blocked`: this errors or loses data. `warning`: it works, but it costs you. */
  severity: 'blocked' | 'warning';
  message: string;
  tableId: string | null;
}

/** Live size of one table, from `pg_class` and `pg_total_relation_size`. */
export interface TableStats {
  rows: number;
  bytes: number;
}

export interface PlanOptions {
  /**
   * Rewrite blocking statements into their lock-light equivalents (default true).
   * `false` gives the textbook DDL instead, which is fine on an empty database and
   * is what `migrate()` returns.
   */
  online?: boolean;
  /** Table sizes by table id. Turns "rewrites the table" into "rewrites 5.2 GB". */
  stats?: Readonly<Record<string, TableStats>>;
}

export interface Plan {
  steps: Step[];
  hazards: Hazard[];
  online: boolean;
}

/** A run of steps that can share one transaction. */
export interface Batch {
  runsInTransaction: boolean;
  steps: Step[];
}

/**
 * Turn a change list into an ordered, annotated list of PostgreSQL statements.
 *
 * Two things happen here that a plain DDL renderer doesn't do.
 *
 * Ordering: the flat diff order isn't safe to execute, so changes are bucketed
 * into phases (drops, renames, creates, alters, constraints, foreign keys,
 * validation). Table drops are FK-ordered and renames are sequenced so a name is
 * free before anything renames into it.
 *
 * Locking: in `online` mode the four statements that would hold ACCESS EXCLUSIVE
 * across a full table scan get decomposed into forms that don't. Every statement
 * is annotated with what it locks, so a caller can refuse a plan instead of
 * finding out in production. Both are argued in decisions.md.
 */
export function plan(before: Schema, changes: readonly Change[], options: PlanOptions = {}): Plan {
  const online = options.online ?? true;
  const stats = options.stats ?? {};
  const after = apply(before, changes);
  const now = names(after, before); // post-migration, `before` covering what was dropped
  const was = names(before);
  const nameFor = uniqueNames();
  const hazards: Hazard[] = [];

  // One bucket per phase; the concat order at the end is the emit order.
  const dropConstraint: Step[] = [];
  const dropColumn: Step[] = [];
  const dropTable: Array<{ tableId: string; step: Step }> = [];
  const tableRenames: Rename[] = [];
  const columnRenames: Array<Rename & { tableId: string }> = [];
  const createTable: Step[] = [];
  const addColumn: Step[] = [];
  const alterColumn: Step[] = [];
  const buildIndex: Step[] = []; // online only: CREATE UNIQUE INDEX CONCURRENTLY
  const addConstraint: Step[] = [];
  const addForeignKey: Step[] = [];
  const validate: Step[] = []; // online only: the scan, deferred and unblocking
  // A primary key may span columns but the model attaches it per column, so
  // collect by table and emit one PRIMARY KEY (...) rather than one per column.
  const pkAdded = new Set<string>();
  const pkDropped = new Set<string>();

  const sizeOf = (tableId: string): string => describeSize(stats[tableId]);

  for (const change of changes) {
    switch (change.kind) {
      case 'drop_constraint': {
        if (change.constraint.kind === 'primary_key') {
          pkDropped.add(change.tableId);
          break;
        }
        const table = was.table(change.tableId);
        const column = was.column(change.tableId, change.columnId);
        dropConstraint.push(
          change.constraint.kind === 'default'
            ? step(`ALTER TABLE ${q(table)} ALTER COLUMN ${q(column)} DROP DEFAULT;`, {
                intent: `drop the default on ${table}.${column}`,
                tableId: change.tableId,
              })
            : step(
                `ALTER TABLE ${q(table)} DROP CONSTRAINT ${q(constraintName(table, column, change.constraint))};`,
                {
                  intent: `drop the ${change.constraint.kind} on ${table}.${column}`,
                  tableId: change.tableId,
                },
              ),
        );
        break;
      }

      case 'drop_column':
        // Postgres only marks the attribute dropped and reclaims the row data
        // lazily, so this is instant at any table size. Also irreversible.
        dropColumn.push(
          step(`ALTER TABLE ${q(was.table(change.tableId))} DROP COLUMN ${q(change.column.name)};`, {
            intent: `drop column ${change.column.name}`,
            tableId: change.tableId,
            destructive: true,
          }),
        );
        hazards.push({
          severity: 'warning',
          message:
            `Dropping ${was.table(change.tableId)}.${change.column.name} discards its data` +
            `${sizeOf(change.tableId)}. There is no undo — take a backup first.`,
          tableId: change.tableId,
        });
        break;

      case 'drop_table':
        dropTable.push({
          tableId: change.tableId,
          step: step(`DROP TABLE ${q(change.table.name)};`, {
            intent: `drop table ${change.table.name}`,
            tableId: change.tableId,
            destructive: true,
          }),
        });
        hazards.push({
          severity: 'warning',
          message: `Dropping table ${change.table.name} discards every row it holds${sizeOf(change.tableId)}.`,
          tableId: change.tableId,
        });
        break;

      case 'rename_table':
        tableRenames.push({ from: change.from, to: change.to });
        break;

      case 'rename_column':
        columnRenames.push({ tableId: change.tableId, from: change.from, to: change.to });
        break;

      case 'add_table':
        createTable.push(
          step(createTableStatement(change.table, now, nameFor), {
            intent: `create table ${change.table.name}`,
            tableId: change.tableId,
          }),
        );
        for (const [column, fk] of foreignKeysOf(change.table)) {
          // A new table is empty, so its own FK validation is free either way.
          addForeignKey.push(
            step(addConstraintStatement(change.table.name, column.name, fk, now, nameFor), {
              intent: `link ${change.table.name}.${column.name} to ${now.table(fk.refTableId)}`,
              tableId: change.tableId,
            }),
          );
        }
        break;

      case 'add_column': {
        const table = now.table(change.tableId);
        addColumn.push(
          step(`ALTER TABLE ${q(table)} ADD COLUMN ${columnDefinition(change.column)};`, {
            intent: `add column ${change.column.name}`,
            tableId: change.tableId,
            ...addColumnCost(change.column),
          }),
        );
        for (const hazard of addColumnHazards(change.column, table, change.tableId, sizeOf)) {
          hazards.push(hazard);
        }
        for (const constraint of change.column.constraints) {
          if (constraint.kind === 'default') continue; // already inline in the definition
          if (constraint.kind === 'primary_key') {
            pkAdded.add(change.tableId);
            continue;
          }
          // Brand new column, so there is nothing to validate against. These go
          // on outright even in online mode.
          const bucket = constraint.kind === 'foreign_key' ? addForeignKey : addConstraint;
          bucket.push(
            step(addConstraintStatement(table, change.column.name, constraint, now, nameFor), {
              intent: `add ${constraint.kind} on ${table}.${change.column.name}`,
              tableId: change.tableId,
            }),
          );
        }
        break;
      }

      case 'change_type': {
        const table = now.table(change.tableId);
        const col = now.column(change.tableId, change.columnId);
        const type = renderType(change.to);
        const impact = typeChangeImpact(change.from, change.to);
        alterColumn.push(
          step(
            `ALTER TABLE ${q(table)} ALTER COLUMN ${q(col)} TYPE ${type} USING ${q(col)}::${type};`,
            {
              intent: `retype ${table}.${col} to ${type}`,
              tableId: change.tableId,
              lock: impact === 'none' ? 'instant' : 'blocking',
              scans: impact !== 'none',
              rewrites: impact === 'rewrite',
            },
          ),
        );
        if (impact !== 'none') {
          hazards.push({
            severity: 'warning',
            message:
              `${table}.${col}: ${renderType(change.from)} → ${type} ${impact === 'rewrite' ? 'rewrites' : 'scans'} ` +
              `the whole table${sizeOf(change.tableId)} while holding ACCESS EXCLUSIVE. ` +
              `Postgres has no online form of this; on a large table do it as a shadow column ` +
              `— add the new column, backfill in batches, swap the names.`,
            tableId: change.tableId,
          });
        }
        break;
      }

      case 'change_nullable': {
        const table = now.table(change.tableId);
        const col = now.column(change.tableId, change.columnId);
        if (change.to) {
          alterColumn.push(
            step(`ALTER TABLE ${q(table)} ALTER COLUMN ${q(col)} DROP NOT NULL;`, {
              intent: `allow NULL in ${table}.${col}`,
              tableId: change.tableId,
            }),
          );
          break;
        }
        if (!online) {
          alterColumn.push(
            step(`ALTER TABLE ${q(table)} ALTER COLUMN ${q(col)} SET NOT NULL;`, {
              intent: `require ${table}.${col}`,
              tableId: change.tableId,
              lock: 'blocking',
              scans: true,
            }),
          );
          break;
        }
        // SET NOT NULL on its own seq-scans the table under ACCESS EXCLUSIVE.
        // Since PG 12 it will instead trust an already-validated
        // CHECK (col IS NOT NULL), and that check can be validated without
        // blocking. Four statements, but the scan happens outside the lock.
        const guard = nameFor(`${table}_${col}_not_null`);
        addConstraint.push(
          step(
            `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(guard)} CHECK (${q(col)} IS NOT NULL) NOT VALID;`,
            {
              intent: `stage the NOT NULL on ${table}.${col} without scanning`,
              tableId: change.tableId,
            },
          ),
        );
        validate.push(
          step(`ALTER TABLE ${q(table)} VALIDATE CONSTRAINT ${q(guard)};`, {
            intent: `check existing rows of ${table}.${col} — reads and writes continue`,
            tableId: change.tableId,
            lock: 'concurrent',
            scans: true,
          }),
          step(`ALTER TABLE ${q(table)} ALTER COLUMN ${q(col)} SET NOT NULL;`, {
            intent: `promote to a real NOT NULL (free — the validated CHECK proves it)`,
            tableId: change.tableId,
          }),
          step(`ALTER TABLE ${q(table)} DROP CONSTRAINT ${q(guard)};`, {
            intent: `drop the scaffolding CHECK`,
            tableId: change.tableId,
          }),
        );
        break;
      }

      case 'add_constraint': {
        if (change.constraint.kind === 'primary_key') {
          pkAdded.add(change.tableId);
          break;
        }
        const table = now.table(change.tableId);
        const column = now.column(change.tableId, change.columnId);
        if (change.constraint.kind === 'default') {
          // Metadata only since PG 11. Existing rows are not touched.
          addConstraint.push(
            step(
              `ALTER TABLE ${q(table)} ALTER COLUMN ${q(column)} SET DEFAULT ${change.constraint.expr};`,
              { intent: `default ${table}.${column} to ${change.constraint.expr}`, tableId: change.tableId },
            ),
          );
          break;
        }
        emitAddConstraint(change.constraint, {
          table,
          column,
          tableId: change.tableId,
          online,
          now,
          nameFor,
          buildIndex,
          addConstraint,
          addForeignKey,
          validate,
        });
        break;
      }
    }
  }

  for (const tableId of pkDropped) {
    const table = was.table(tableId);
    dropConstraint.push(
      step(`ALTER TABLE ${q(table)} DROP CONSTRAINT ${q(`${table}_pkey`)};`, {
        intent: `drop the primary key on ${table}`,
        tableId,
      }),
    );
  }
  for (const tableId of pkAdded) {
    const table = now.table(tableId);
    const columns = primaryKeyColumns(after, tableId);
    if (columns.length === 0) continue;
    const isNew = !before.tables.some((t) => t.id === tableId);
    if (!online || isNew) {
      addConstraint.push(
        step(
          `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(nameFor(`${table}_pkey`))} ` +
            `PRIMARY KEY (${columns.map(q).join(', ')});`,
          {
            intent: `primary key on ${table}`,
            tableId,
            ...(isNew ? {} : { lock: 'blocking' as const, scans: true }),
          },
        ),
      );
      continue;
    }
    // Build the index without blocking, then adopt it, so the ADD CONSTRAINT is
    // a catalog flip rather than an index build.
    const index = nameFor(`${table}_pkey`);
    buildIndex.push(
      step(`CREATE UNIQUE INDEX CONCURRENTLY ${q(index)} ON ${q(table)} (${columns.map(q).join(', ')});`, {
        intent: `build the primary key index on ${table} without blocking writes`,
        tableId,
        lock: 'concurrent',
        scans: true,
        runsInTransaction: false,
      }),
    );
    addConstraint.push(
      step(`ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(index)} PRIMARY KEY USING INDEX ${q(index)};`, {
        intent: `adopt the index as the primary key on ${table}`,
        tableId,
      }),
    );
    const nullable = columns.filter((name) => isNullable(after, tableId, name));
    if (nullable.length > 0) {
      hazards.push({
        severity: 'warning',
        message:
          `The primary key on ${table} covers nullable column(s) ${nullable.join(', ')}. ` +
          `Postgres will add the NOT NULL itself, which scans the table${sizeOf(tableId)} under ` +
          `ACCESS EXCLUSIVE — mark them NOT NULL in the same change so that scan happens online.`,
        tableId,
      });
    }
  }

  const steps = [
    ...dropConstraint,
    ...dropColumn,
    ...orderTableDrops(dropTable, before),
    ...sequenceRenames(tableRenames, allTableNames(before, after)).map(([from, to]) =>
      step(`ALTER TABLE ${q(from)} RENAME TO ${q(to)};`, {
        intent: `rename table ${from} → ${to}`,
        tableId: null,
      }),
    ),
    ...columnRenameStatements(columnRenames, before, after, now),
    ...createTable,
    ...addColumn,
    ...alterColumn,
    ...buildIndex,
    ...addConstraint,
    ...addForeignKey,
    ...validate,
  ];

  if (online) {
    for (const hazard of concurrencyHazards(steps)) hazards.push(hazard);
  } else if (steps.some((s) => s.lock === 'blocking')) {
    hazards.push({
      severity: 'warning',
      message:
        'This is the direct plan: statements are emitted in their textbook form, ' +
        'including the ones that hold ACCESS EXCLUSIVE across a full table scan. ' +
        'Fine on an empty database — switch to the online plan before running it ' +
        'anywhere with data in it.',
      tableId: null,
    });
  }

  return { steps, hazards, online };
}

/**
 * Group steps into transactions. Everything shares one transaction, so a failure
 * rolls the whole migration back. The exception is statements Postgres won't run
 * inside a transaction; those become batches of their own.
 */
export function batches(steps: readonly Step[]): Batch[] {
  const out: Batch[] = [];
  for (const step of steps) {
    const last = out[out.length - 1];
    if (last && last.runsInTransaction === step.runsInTransaction && step.runsInTransaction) {
      last.steps.push(step);
    } else {
      out.push({ runsInTransaction: step.runsInTransaction, steps: [step] });
    }
  }
  return out;
}

// --- step construction ---------------------------------------------------

interface StepMeta {
  intent: string;
  tableId: string | null;
  lock?: LockLevel;
  scans?: boolean;
  rewrites?: boolean;
  runsInTransaction?: boolean;
  destructive?: boolean;
}

/** Defaults are the common case: a catalog-only change, safe at any table size. */
function step(sql: string, meta: StepMeta): Step {
  return {
    sql,
    intent: meta.intent,
    tableId: meta.tableId,
    lock: meta.lock ?? 'instant',
    scans: meta.scans ?? false,
    rewrites: meta.rewrites ?? false,
    runsInTransaction: meta.runsInTransaction ?? true,
    destructive: meta.destructive ?? false,
  };
}

interface ConstraintSink {
  table: string;
  column: string;
  tableId: string;
  online: boolean;
  now: NameLookup;
  nameFor: Namer;
  buildIndex: Step[];
  addConstraint: Step[];
  addForeignKey: Step[];
  validate: Step[];
}

/**
 * Add a constraint to a table that already has rows. Each kind avoids the
 * scan-under-exclusive-lock differently:
 *
 * check, foreign_key: add NOT VALID (no scan), then VALIDATE CONSTRAINT on its
 *   own, which scans under SHARE UPDATE EXCLUSIVE.
 * unique: there is no NOT VALID for uniqueness, so build the index CONCURRENTLY
 *   and attach it with ADD CONSTRAINT ... USING INDEX.
 */
function emitAddConstraint(
  constraint: Exclude<ColumnConstraint, { kind: 'default' | 'primary_key' }>,
  sink: ConstraintSink,
): void {
  const { table, column, tableId, online, now, nameFor } = sink;
  const name = nameFor(constraintName(table, column, constraint));
  const where = `${table}.${column}`;

  if (!online) {
    const bucket = constraint.kind === 'foreign_key' ? sink.addForeignKey : sink.addConstraint;
    bucket.push(
      step(
        `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(name)} ${constraintBody(constraint, column, now)};`,
        { intent: `add ${constraint.kind} on ${where}`, tableId, lock: 'blocking', scans: true },
      ),
    );
    return;
  }

  if (constraint.kind === 'unique') {
    // ADD CONSTRAINT ... UNIQUE builds its index under ACCESS EXCLUSIVE. Build
    // it outside the lock and adopt it, leaving the ALTER as a catalog flip.
    sink.buildIndex.push(
      step(`CREATE UNIQUE INDEX CONCURRENTLY ${q(name)} ON ${q(table)} (${q(column)});`, {
        intent: `build the unique index on ${where} without blocking writes`,
        tableId,
        lock: 'concurrent',
        scans: true,
        runsInTransaction: false,
      }),
    );
    sink.addConstraint.push(
      step(`ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(name)} UNIQUE USING INDEX ${q(name)};`, {
        intent: `adopt the index as the unique constraint on ${where}`,
        tableId,
      }),
    );
    return;
  }

  const bucket = constraint.kind === 'foreign_key' ? sink.addForeignKey : sink.addConstraint;
  bucket.push(
    step(
      `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(name)} ${constraintBody(constraint, column, now)} NOT VALID;`,
      { intent: `add ${constraint.kind} on ${where}, unverified — no scan, no blocking`, tableId },
    ),
  );
  sink.validate.push(
    step(`ALTER TABLE ${q(table)} VALIDATE CONSTRAINT ${q(name)};`, {
      intent: `verify existing rows against ${name} — reads and writes continue`,
      tableId,
      lock: 'concurrent',
      scans: true,
    }),
  );
}

/** What ADD COLUMN costs. Since PG 11 a non-volatile default lives in the catalog. */
function addColumnCost(column: Column): Pick<StepMeta, 'lock' | 'rewrites'> {
  const def = column.constraints.find((c) => c.kind === 'default');
  return def && isVolatile(def.expr)
    ? { lock: 'blocking', rewrites: true }
    : { lock: 'instant', rewrites: false };
}

function addColumnHazards(
  column: Column,
  table: string,
  tableId: string,
  sizeOf: (tableId: string) => string,
): Hazard[] {
  const def = column.constraints.find((c) => c.kind === 'default');
  if (!column.nullable && !def) {
    return [
      {
        severity: 'blocked',
        message:
          `${table}.${column.name} is NOT NULL with no default. Postgres rejects that on a ` +
          `table that already has rows${sizeOf(tableId)} — there is nothing to put in the ` +
          `existing ones. Give it a default, or add it nullable and tighten it afterwards.`,
        tableId,
      },
    ];
  }
  if (def && isVolatile(def.expr)) {
    return [
      {
        severity: 'warning',
        message:
          `${table}.${column.name} defaults to ${def.expr}, which is volatile. Postgres can ` +
          `only store a constant default in the catalog, so this rewrites every row${sizeOf(tableId)} ` +
          `under ACCESS EXCLUSIVE. Add the column with no default, backfill in batches, then set the default.`,
        tableId,
      },
    ];
  }
  return [];
}

/** Functions that differ per row, so PG 11's catalog-only default doesn't apply. */
const VOLATILE = /\b(now|clock_timestamp|current_timestamp|localtimestamp|current_date|current_time|random|gen_random_uuid|uuid_generate_v[14]|nextval)\b/i;

function isVolatile(expr: string): boolean {
  return VOLATILE.test(expr);
}

function concurrencyHazards(steps: readonly Step[]): Hazard[] {
  if (!steps.some((s) => !s.runsInTransaction)) return [];
  return [
    {
      severity: 'warning',
      message:
        'CREATE INDEX CONCURRENTLY cannot run inside a transaction, so this plan commits in ' +
        'more than one piece and is not all-or-nothing. If it fails partway, the index is left ' +
        'behind and marked invalid — drop it and re-run.',
      tableId: null,
    },
  ];
}

/**
 * Does changing a column's type make Postgres touch the rows?
 *
 * `none` covers only the cases where Postgres has a typmod transform proving
 * every existing value is still valid: widening a varchar, dropping its length
 * limit, widening a numeric at the same scale. Everything else rewrites the
 * heap, including int to bigint, which looks like it shouldn't.
 */
function typeChangeImpact(from: ColumnType, to: ColumnType): 'none' | 'scan' | 'rewrite' {
  if (from.kind === 'varchar' && to.kind === 'text') return 'none';
  if (from.kind === 'varchar' && to.kind === 'varchar') {
    return to.length >= from.length ? 'none' : 'rewrite';
  }
  if (from.kind === 'numeric' && to.kind === 'numeric') {
    const widened = to.precision >= from.precision && to.scale === from.scale;
    return widened ? 'none' : 'rewrite';
  }
  return 'rewrite';
}

// --- ordering ------------------------------------------------------------

/**
 * Order DROP TABLEs so a table goes before any table it references, when both are
 * being dropped. Post-order DFS over the reversed FK graph.
 *
 * Mutual FKs form a cycle, which no ordering can make safe; that needs CASCADE or
 * an explicit constraint drop. We break the cycle at an arbitrary edge.
 */
function orderTableDrops(
  drops: ReadonlyArray<{ tableId: string; step: Step }>,
  before: Schema,
): Step[] {
  const dropped = new Set(drops.map((d) => d.tableId));
  const tableById = new Map(before.tables.map((t) => [t.id, t]));

  // referers.get(target): dropped tables with an FK into target. Those go first.
  const referers = new Map<string, Set<string>>(drops.map((d) => [d.tableId, new Set()]));
  for (const { tableId } of drops) {
    for (const column of tableById.get(tableId)?.columns ?? []) {
      for (const c of column.constraints) {
        if (c.kind === 'foreign_key' && c.refTableId !== tableId && dropped.has(c.refTableId)) {
          referers.get(c.refTableId)!.add(tableId);
        }
      }
    }
  }

  const stepById = new Map(drops.map((d) => [d.tableId, d.step]));
  const ordered: Step[] = [];
  const done = new Set<string>();
  const inProgress = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id) || inProgress.has(id)) return; // second condition breaks FK cycles
    inProgress.add(id);
    for (const referer of referers.get(id) ?? []) visit(referer);
    inProgress.delete(id);
    done.add(id);
    ordered.push(stepById.get(id)!);
  };
  for (const { tableId } of drops) visit(tableId);
  return ordered;
}

interface Rename {
  from: string;
  to: string;
}

/**
 * Sequence renames so nothing renames into a name that is still occupied. A
 * rename waits for whichever pending rename frees its target.
 *
 * A swap is a cycle and can't be ordered out, so one member parks on a temporary
 * name and lands on its real one at the end. Three statements for a swap.
 * `taken` is every name currently live, so the temporary can't collide.
 */
function sequenceRenames(
  renames: readonly Rename[],
  taken: ReadonlySet<string>,
): Array<[string, string]> {
  const pending = renames.map((r) => ({ ...r }));
  const reserved = new Set(taken);
  for (const r of pending) reserved.add(r.to);

  const out: Array<[string, string]> = [];
  while (pending.length > 0) {
    const free = pending.findIndex((r) => !pending.some((o) => o !== r && o.from === r.to));
    if (free >= 0) {
      const [r] = pending.splice(free, 1);
      out.push([r!.from, r!.to]);
      continue;
    }
    // Everything left is blocked by something else, so it's a cycle. Park one.
    const r = pending.shift()!;
    const temp = temporaryName(r.from, reserved);
    reserved.add(temp);
    out.push([r.from, temp]);
    pending.push({ from: temp, to: r.to });
  }
  return out;
}

function temporaryName(base: string, taken: ReadonlySet<string>): string {
  let name = `${base}__tmp`;
  for (let n = 2; taken.has(name); n++) name = `${base}__tmp${n}`;
  return name;
}

/** Sequenced per table, since column names only have to be unique within one. */
function columnRenameStatements(
  renames: ReadonlyArray<Rename & { tableId: string }>,
  before: Schema,
  after: Schema,
  now: NameLookup,
): Step[] {
  const byTable = new Map<string, Rename[]>();
  for (const { tableId, from, to } of renames) {
    const bucket = byTable.get(tableId);
    if (bucket) bucket.push({ from, to });
    else byTable.set(tableId, [{ from, to }]);
  }

  const out: Step[] = [];
  for (const [tableId, group] of byTable) {
    const table = now.table(tableId);
    for (const [from, to] of sequenceRenames(group, allColumnNames(before, after, tableId))) {
      out.push(
        step(`ALTER TABLE ${q(table)} RENAME COLUMN ${q(from)} TO ${q(to)};`, {
          intent: `rename ${table}.${from} → ${to}`,
          tableId,
        }),
      );
    }
  }
  return out;
}

// --- statement builders --------------------------------------------------

function createTableStatement(table: Table, names: NameLookup, nameFor: Namer): string {
  const pk = table.columns
    .filter((c) => c.constraints.some((k) => k.kind === 'primary_key'))
    .map((c) => c.name);

  const lines = [
    ...table.columns.map((column) => `  ${columnDefinition(column)}`),
    ...(pk.length > 0
      ? [`  CONSTRAINT ${q(nameFor(`${table.name}_pkey`))} PRIMARY KEY (${pk.map(q).join(', ')})`]
      : []),
    ...table.columns.flatMap((column) =>
      column.constraints
        .filter((c) => c.kind !== 'default' && c.kind !== 'foreign_key' && c.kind !== 'primary_key')
        .map(
          (c) =>
            `  CONSTRAINT ${q(nameFor(constraintName(table.name, column.name, c)))} ` +
            constraintBody(c, column.name, names),
        ),
    ),
  ];
  return `CREATE TABLE ${q(table.name)} (\n${lines.join(',\n')}\n);`;
}

/** Name, type, NOT NULL, DEFAULT. pk/unique/check/fk are separate statements. */
function columnDefinition(column: Column): string {
  const parts = [q(column.name), renderType(column.type)];
  if (!column.nullable) parts.push('NOT NULL');
  for (const c of column.constraints) {
    if (c.kind === 'default') parts.push(`DEFAULT ${c.expr}`);
  }
  return parts.join(' ');
}

function addConstraintStatement(
  table: string,
  column: string,
  constraint: Exclude<ColumnConstraint, { kind: 'default' | 'primary_key' }>,
  names: NameLookup,
  nameFor: Namer,
): string {
  return (
    `ALTER TABLE ${q(table)} ADD CONSTRAINT ${q(nameFor(constraintName(table, column, constraint)))} ` +
    `${constraintBody(constraint, column, names)};`
  );
}

function constraintBody(
  constraint: Exclude<ColumnConstraint, { kind: 'default' | 'primary_key' }>,
  column: string,
  names: NameLookup,
): string {
  switch (constraint.kind) {
    case 'unique':
      return `UNIQUE (${q(column)})`;
    case 'check':
      return `CHECK (${constraint.expr})`;
    case 'foreign_key':
      return (
        `FOREIGN KEY (${q(column)}) REFERENCES ${q(names.table(constraint.refTableId))} ` +
        `(${q(names.column(constraint.refTableId, constraint.refColumnId))})`
      );
  }
}

/** PostgreSQL's own convention, so our names match hand-written schemas. */
function constraintName(
  table: string,
  column: string,
  constraint: Exclude<ColumnConstraint, { kind: 'default' }>,
): string {
  switch (constraint.kind) {
    case 'primary_key':
      return `${table}_pkey`;
    case 'unique':
      return `${table}_${column}_key`;
    case 'check':
      return `${table}_${column}_check`;
    case 'foreign_key':
      return `${table}_${column}_fkey`;
  }
}

type Namer = (base: string) => string;

/**
 * Postgres disambiguates a repeated auto-generated name with a numeric suffix
 * (t_c_check, t_c_check1). Do the same, or two checks on one column emit two
 * colliding ADD CONSTRAINTs.
 */
function uniqueNames(): Namer {
  const used = new Map<string, number>();
  return (base) => {
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}${seen}`;
  };
}

function renderType(type: ColumnType): string {
  switch (type.kind) {
    case 'int':
      return 'integer';
    case 'bigint':
      return 'bigint';
    case 'text':
      return 'text';
    case 'boolean':
      return 'boolean';
    case 'varchar':
      return `varchar(${type.length})`;
    case 'numeric':
      return `numeric(${type.precision},${type.scale})`;
    case 'timestamp':
      return type.withTimezone ? 'timestamp with time zone' : 'timestamp without time zone';
    case 'other':
      return type.sql;
  }
}

// --- names -------------------------------------------------------------

interface NameLookup {
  table(tableId: string): string;
  column(tableId: string, columnId: string): string;
}

/**
 * id to name. Pass schemas newest-first, like the app's `makeNames`: the first one
 * that knows an id wins, so a rename resolves to its new name and a dropped entity
 * still resolves to something.
 */
function names(...schemas: Schema[]): NameLookup {
  const tables = new Map<string, string>();
  const columns = new Map<string, Map<string, string>>();
  for (const schema of [...schemas].reverse()) {
    for (const table of schema.tables) {
      tables.set(table.id, table.name);
      const cols = columns.get(table.id) ?? new Map<string, string>();
      for (const column of table.columns) cols.set(column.id, column.name);
      columns.set(table.id, cols);
    }
  }
  return {
    table: (id) => tables.get(id) ?? id,
    column: (tableId, columnId) => columns.get(tableId)?.get(columnId) ?? columnId,
  };
}

function allTableNames(...schemas: Schema[]): Set<string> {
  return new Set(schemas.flatMap((s) => s.tables.map((t) => t.name)));
}

function allColumnNames(before: Schema, after: Schema, tableId: string): Set<string> {
  const out = new Set<string>();
  for (const schema of [before, after]) {
    for (const table of schema.tables) {
      if (table.id === tableId) for (const column of table.columns) out.add(column.name);
    }
  }
  return out;
}

function primaryKeyColumns(schema: Schema, tableId: string): string[] {
  const table = schema.tables.find((t) => t.id === tableId);
  return (table?.columns ?? [])
    .filter((c) => c.constraints.some((k) => k.kind === 'primary_key'))
    .map((c) => c.name);
}

function isNullable(schema: Schema, tableId: string, columnName: string): boolean {
  const table = schema.tables.find((t) => t.id === tableId);
  return table?.columns.find((c) => c.name === columnName)?.nullable ?? false;
}

type ForeignKey = Extract<ColumnConstraint, { kind: 'foreign_key' }>;

function foreignKeysOf(table: Table): Array<[Column, ForeignKey]> {
  const out: Array<[Column, ForeignKey]> = [];
  for (const column of table.columns) {
    for (const c of column.constraints) {
      if (c.kind === 'foreign_key') out.push([column, c]);
    }
  }
  return out;
}

/** " (5.2 GB / ~48M rows)", or "" when there are no stats for the table. */
function describeSize(stats: TableStats | undefined): string {
  if (!stats) return '';
  return ` (${formatBytes(stats.bytes)} / ~${formatRows(stats.rows)} rows)`;
}

// The app renders these too, but the engine must not import from app/, so this
// is duplicated on purpose. See src/app/lib/format.ts.
function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${n < 10 && unit > 0 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`;
}

function formatRows(rows: number): string {
  if (rows >= 1e9) return `${(rows / 1e9).toFixed(1)}B`;
  if (rows >= 1e6) return `${(rows / 1e6).toFixed(1)}M`;
  if (rows >= 1e3) return `${Math.round(rows / 1e3)}k`;
  return String(rows);
}

/** Double-quote an identifier, escaping embedded quotes, like `pg_dump`. */
function q(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
