// EnvInfo.isDev() requires a GlobalDataStorage implementation that only exists in a running app
// (the same mock the containment suite uses).
jest.mock('@proteinjs/server-api', () => ({
  EnvInfo: { isDev: () => true },
}));

/**
 * The world the runner sees, planted per test: the system db (a ledger in memory — the runner's
 * every read and write lands here, so writes are OBSERVABLE) and the build's declared migrations
 * (the reflection source-record loaders for the migration table, which this harness has no
 * reflection graph to serve).
 */
const mockWorld = {
  db: undefined as unknown as FakeLedgerDb,
  loaders: [] as { loader: { table: { name: string }; record: unknown } }[],
};
jest.mock('../src/Db', () => ({
  ...jest.requireActual('../src/Db'),
  getDbAsSystem: () => mockWorld.db,
}));
jest.mock('../src/source/SourceRecord', () => ({
  ...jest.requireActual('../src/source/SourceRecord'),
  getSourceRecordLoaders: () => mockWorld.loaders,
}));

import { Logger, Log, DefaultLogWriter } from '@proteinjs/logger';
import { MigrationRunner } from '../src/MigrationRunner';
import { Migration, MigrationEstimate, MigrationTable } from '../src/tables/MigrationTable';
import { SourceRecordRepo } from '../src/source/SourceRecordRepo';

/**
 * The plan before the run (the estimate door): every pending migration's estimate is logged as
 * one line BEFORE the series' first run, a migration without an estimate says so, and the dry run
 * (`planPendingMigrations`) reads the estimates and applies nothing — no run, no ledger write.
 *
 * Pinned on OUTCOMES: the order of events (log lines vs. run effects) in one shared list, the
 * writes the fake ledger received, the plan's own numbers.
 */

/** A migration ledger in memory, with the reads and writes the runner makes. */
class FakeLedgerDb {
  rows: Migration[] = [];
  writes: Partial<Migration>[] = [];
  exists = true;
  async tableExists(): Promise<boolean> {
    return this.exists;
  }
  async query(): Promise<Migration[]> {
    return this.rows.map((row) => ({ ...row }));
  }
  async get(_table: unknown, { id }: { id: string }): Promise<Migration | undefined> {
    const row = this.rows.find((candidate) => candidate.id === id);
    return row ? { ...row } : undefined;
  }
  async update(_table: unknown, partial: Partial<Migration>): Promise<void> {
    this.writes.push(partial);
    const row = this.rows.find((candidate) => candidate.id === partial.id);
    if (row) {
      Object.assign(row, partial);
    }
  }
}

type RunnerInternals = { logger: Logger };

describe('MigrationRunner — the plan before the run', () => {
  const migrationTable = new MigrationTable();
  let events: string[];
  let db: FakeLedgerDb;
  let plantedIds: string[];

  /** A source declaration registered in this process (what init's source sync registers). */
  const plant = (
    id: string,
    overrides: Partial<Migration> & { estimate?: () => Promise<MigrationEstimate> } = {}
  ): Migration => {
    const migration = {
      id,
      description: `plan test migration ${id}`,
      run: async () => {
        events.push(`run:${id}`);
        return `${id} output`;
      },
      ...overrides,
    } as Migration;
    new SourceRecordRepo().loadSourceRecord(migrationTable.name, migration);
    plantedIds.push(id);
    return migration;
  };

  /** A ledger row for a planted migration, as the source sync lands it. */
  const ledgerRow = (
    migration: Migration,
    status: Migration['status'] = 'proposed',
    extra: Partial<Migration> = {}
  ) => {
    db.rows.push({ id: migration.id, description: migration.description, status, ...extra } as Migration);
  };

  const runner = () => {
    const instance = new MigrationRunner();
    (instance as unknown as RunnerInternals).logger = new Logger({
      name: 'MigrationRunner',
      logWriter: {
        write: (log: Log) => {
          events.push(`log:${log.message}`);
        },
      } as unknown as DefaultLogWriter,
    });
    return instance;
  };

  const planLines = () => events.filter((event) => event.startsWith('log:Migration plan'));

  beforeEach(() => {
    events = [];
    db = new FakeLedgerDb();
    plantedIds = [];
    mockWorld.db = db;
    mockWorld.loaders = [];
  });

  afterEach(() => {
    // The repo is a process-wide static: unregister what this test planted so ids never leak
    // between tests (a stale registration would resolve a later test's ghost row).
    const repo = new SourceRecordRepo() as unknown as { constructor: { SOURCE_RECORD_MAP: Record<string, unknown> } };
    for (const id of plantedIds) {
      delete repo.constructor.SOURCE_RECORD_MAP[`${migrationTable.name}:${id}`];
    }
  });

  it('logs each pending migration’s plan line and the total BEFORE the first run, and the series still runs', async () => {
    const estimated = plant('plan-a-estimated', {
      estimate: async () => ({
        units: 40,
        unit: 'roots',
        secondsPerUnit: 0.3,
        note: 'measured on a rehearsal',
      }),
    });
    const unestimated = plant('plan-b-unestimated');
    ledgerRow(estimated);
    ledgerRow(unestimated);

    const summary = await runner().runPendingMigrations();

    expect(summary.applied).toEqual(['plan-a-estimated', 'plan-b-unestimated']);
    expect(planLines()).toEqual([
      'log:Migration plan: (plan-a-estimated) plan test migration plan-a-estimated — 40 roots, ≈ 12 s at 0.3 s per unit (measured on a rehearsal)',
      'log:Migration plan: (plan-b-unestimated) plan test migration plan-b-unestimated — no estimate declared',
      'log:Migration plan total: 2 pending, ≈ 12 s projected over 1 of them, 1 without a projection (plan-b-unestimated)',
    ]);
    // Every plan line lands before the FIRST run effect — the reader knows the whole plan before
    // a row changes.
    const firstRun = events.indexOf('run:plan-a-estimated');
    expect(firstRun).toBeGreaterThan(-1);
    for (const line of planLines()) {
      expect(events.indexOf(line)).toBeLessThan(firstRun);
    }
    expect(events.indexOf('run:plan-b-unestimated')).toBeGreaterThan(firstRun);
  });

  it('the dry run reads the estimates and applies nothing — no run, no ledger write, an unresolved row reported not stamped', async () => {
    let estimateReads = 0;
    const pendingA = plant('dry-a', {
      estimate: async () => {
        estimateReads++;
        return { units: 3, unit: 'rows', secondsPerUnit: 2 };
      },
    });
    const pendingB = plant('dry-b', {
      estimate: async () => {
        estimateReads++;
        return { units: 10, unit: 'rows', secondsPerUnit: 0.5 };
      },
    });
    const counted = plant('dry-c-counted-only', {
      estimate: async () => ({ units: 5, unit: 'items', note: 'no timing yet' }),
    });
    const applied = plant('dry-d-applied', { estimate: async () => ({ units: 999, unit: 'rows', secondsPerUnit: 9 }) });
    const manual = plant('dry-e-manual', { manual: true } as Partial<Migration>);
    const retired = plant('dry-f-retired');
    ledgerRow(pendingA);
    ledgerRow(pendingB, 'failure');
    ledgerRow(counted, 'running');
    ledgerRow(applied, 'success');
    ledgerRow(manual);
    ledgerRow(retired, 'proposed', { retired: true });
    db.rows.push({ id: 'dry-g-ghost', description: 'loader deleted after an old release ran it' } as Migration);

    const plan = await runner().planPendingMigrations();

    expect(events.filter((event) => event.startsWith('run:'))).toEqual([]);
    expect(db.writes).toEqual([]);
    expect(estimateReads).toBe(2);
    expect(plan.pending.map((entry) => entry.id)).toEqual(['dry-a', 'dry-b', 'dry-c-counted-only']);
    expect(plan.pending[0]).toEqual({
      id: 'dry-a',
      description: 'plan test migration dry-a',
      estimate: { units: 3, unit: 'rows', secondsPerUnit: 2 },
      projectedSeconds: 6,
    });
    expect(plan.pending[1].projectedSeconds).toBe(5);
    expect(plan.pending[2]).toEqual({
      id: 'dry-c-counted-only',
      description: 'plan test migration dry-c-counted-only',
      estimate: { units: 5, unit: 'items', note: 'no timing yet' },
      unprojectedReason: 'no seconds per unit declared',
    });
    expect(plan.projectedSeconds).toBe(11);
    expect(plan.projected).toBe(2);
    expect(plan.unprojected).toEqual(['dry-c-counted-only']);
    expect(plan.alreadyApplied).toEqual(['dry-d-applied']);
    expect(plan.skippedManual).toEqual(['dry-e-manual']);
    expect(plan.retired).toEqual(['dry-f-retired']);
    expect(plan.unresolved).toEqual(['dry-g-ghost']);
    expect(plan.freshDatabase).toBe(false);
    expect(planLines()).toEqual([
      'log:Migration plan: (dry-a) plan test migration dry-a — 3 rows, ≈ 6 s at 2 s per unit',
      'log:Migration plan: (dry-b) plan test migration dry-b — 10 rows, ≈ 5 s at 0.5 s per unit',
      'log:Migration plan: (dry-c-counted-only) plan test migration dry-c-counted-only — 5 items, no seconds per unit declared (no timing yet)',
      'log:Migration plan total: 3 pending, ≈ 11 s projected over 2 of them, 1 without a projection (dry-c-counted-only)',
    ]);
  });

  it('plans a migration the build declares that has no ledger row yet — after the ledger’s pending rows, in id order', async () => {
    const inLedger = plant('new-0-in-ledger', {
      estimate: async () => ({ units: 1, unit: 'rows', secondsPerUnit: 1 }),
    });
    ledgerRow(inLedger);
    const declaredOnly = (id: string, estimate?: () => Promise<MigrationEstimate>) => ({
      loader: {
        table: { name: migrationTable.name },
        record: { id, description: `declared ${id}`, run: async () => events.push(`run:${id}`), estimate },
      },
    });
    mockWorld.loaders = [
      declaredOnly('new-z-later', async () => ({ units: 4, unit: 'rows', secondsPerUnit: 10, note: 'new this build' })),
      declaredOnly('new-m-manual-later'),
      {
        loader: {
          table: { name: 'some_other_source_table' },
          record: { id: 'not-a-migration', run: async () => undefined },
        },
      },
      declaredOnly('new-b-earlier'),
    ];
    (mockWorld.loaders[1].loader.record as Migration).manual = true;
    (mockWorld.loaders[1].loader.record as Migration).preSchemaSync = false;
    (mockWorld.loaders[3].loader.record as Migration).preSchemaSync = true;

    const plan = await runner().planPendingMigrations();

    expect(plan.pending.map((entry) => entry.id)).toEqual(['new-0-in-ledger', 'new-b-earlier', 'new-z-later']);
    expect(plan.pending[1]).toEqual({
      id: 'new-b-earlier',
      description: 'declared new-b-earlier',
      preSchemaSync: true,
      unprojectedReason: 'no estimate declared',
    });
    expect(plan.pending[2].projectedSeconds).toBe(40);
    expect(plan.projectedSeconds).toBe(41);
    expect(plan.skippedManual).toEqual(['new-m-manual-later']);
    expect(events.filter((event) => event.startsWith('run:'))).toEqual([]);
    expect(db.writes).toEqual([]);
    expect(planLines()[1]).toBe(
      'log:Migration plan: (new-b-earlier) declared new-b-earlier [runs at init, before schema sync] — no estimate declared'
    );
  });

  it('on a fresh database (no ledger table) lists every declared migration and reads no estimate', async () => {
    db.exists = false;
    mockWorld.loaders = [
      {
        loader: {
          table: { name: migrationTable.name },
          record: {
            id: 'fresh-a',
            description: 'declared fresh-a',
            run: async () => events.push('run:fresh-a'),
            estimate: async () => {
              throw new Error('the estimate must not be read on a fresh database — its tables do not exist');
            },
          },
        },
      },
    ];

    const plan = await runner().planPendingMigrations();

    expect(plan.freshDatabase).toBe(true);
    expect(plan.pending).toEqual([
      { id: 'fresh-a', description: 'declared fresh-a', unprojectedReason: 'fresh database, nothing to count' },
    ]);
    expect(plan.projectedSeconds).toBe(0);
    expect(plan.unprojected).toEqual(['fresh-a']);
    expect(planLines()).toEqual([
      'log:Migration plan: (fresh-a) declared fresh-a — fresh database, nothing to count',
      'log:Migration plan total: 1 pending, ≈ 0 s projected over 0 of them, 1 without a projection (fresh-a)',
    ]);
    expect(db.writes).toEqual([]);
  });

  it('an estimate that throws fails the plan loudly — a plan that cannot count is not a plan', async () => {
    const broken = plant('broken-estimate', {
      estimate: async () => {
        throw new Error('count query failed');
      },
    });
    ledgerRow(broken);

    await expect(runner().planPendingMigrations()).rejects.toThrow('count query failed');
    expect(events.filter((event) => event.startsWith('run:'))).toEqual([]);
    expect(db.writes).toEqual([]);
  });
});
