import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { getDbAsSystem, Migration, MigrationRunner, MigrationTable, SourceRecordRepo, Table } from '@proteinjs/db';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import moment from 'moment';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * MigrationRunner.runPendingMigrations over the real stack (plans/POST_RELEASE_QUEUE.md 27f):
 * the deploy-gated series the migration Job runs before a rollout advances.
 *
 * Outcome pins, on the ledger itself (rows written, run effects observed — not interactions):
 * - SERIES ORDER: oldest-first by the ledger row's `created`, id tiebreak — regardless of
 *   insert order.
 * - MANUAL EXCLUSION: `manual: true` migrations never run in the series, and the
 *   Migrations-page flow (`runMigration`) still runs them — the flag excludes, it does not
 *   disable.
 * - FAILURE SURFACING: the first failure stops the series; the failed id + not-attempted tail
 *   are reported so the Job can fail the deploy; a later series retries the failed row and
 *   finishes the tail.
 * - HISTORY HONESTY: ledger rows whose source loader is gone (the table keeps history) are
 *   skipped and reported as unresolved, never crash the series — and STAMPED `retired: true`.
 * - RETIREMENT: a retired row is never auto-run, even when its source class ships again in a
 *   later build; only un-retiring it (the Migrations-page toggle) re-arms the series.
 *
 * All series runs execute SESSIONLESS (no test user registered) — the deploy Job has no user
 * session, and UserAuth is fail-closed: these tests passing IS the pin that the series records
 * through the system db.
 */

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

describe('MigrationRunner.runPendingMigrations (spanner)', () => {
  const migrationTable = new MigrationTable() as Table<Migration>;
  const dropTable = getDropTestTable(spannerDriver);
  const sourceRecordRepo = new SourceRecordRepo();
  const base = moment('2026-01-01T00:00:00Z');
  let runLog: string[] = [];

  /** A source-backed migration whose execution lands in runLog — order is observable. */
  const plantMigration = (id: string, overrides: Partial<Migration> = {}): Migration => {
    const migration = {
      id,
      description: `pending-series test migration ${id}`,
      run: async () => {
        runLog.push(id);
        return `${id} output`;
      },
      ...overrides,
    } as unknown as Migration;
    sourceRecordRepo.loadSourceRecord(migrationTable.name, migration);
    return migration;
  };

  /** Mirrors SourceRecordLoader's insert (system path) with an explicit ledger `created`. */
  const insertLedgerRow = async (migration: Migration, createdOffsetMinutes: number) => {
    await getDbAsSystem().insert(migrationTable, {
      ...migration,
      created: moment(base).add(createdOffsetMinutes, 'minutes'),
    } as any);
  };

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
  }, 60000);

  beforeEach(async () => {
    // Fresh ledger per test: runPendingMigrations sweeps the WHOLE table, so each scenario owns
    // its rows outright. Planted source records from earlier tests stay in the repo harmlessly —
    // discovery is ledger-driven, a source record without a row is invisible.
    runLog = [];
    await dropTable(migrationTable);
    await spannerDriver.getTableManager().loadTable(migrationTable);
  }, 60000);

  afterAll(async () => {
    await dropTable(migrationTable);
    SpannerEmulatorProvisioner.release();
  }, 30000);

  test('runs the series oldest-first by ledger created, id tiebreak — not insert order', async () => {
    const newest = plantMigration('series-c-newest');
    const oldest = plantMigration('series-a-oldest');
    const middle = plantMigration('series-b-middle');
    const tieB = plantMigration('tie-b');
    const tieA = plantMigration('tie-a');
    // Insert order deliberately scrambled vs ledger order; the tie pair shares one created.
    await insertLedgerRow(newest, 2);
    await insertLedgerRow(tieB, 3);
    await insertLedgerRow(oldest, 0);
    await insertLedgerRow(tieA, 3);
    await insertLedgerRow(middle, 1);

    const summary = await new MigrationRunner().runPendingMigrations();

    expect(runLog).toEqual(['series-a-oldest', 'series-b-middle', 'series-c-newest', 'tie-a', 'tie-b']);
    expect(summary.applied).toEqual(runLog);
    expect(summary.failed).toBeUndefined();
    expect(summary.notAttempted).toEqual([]);
    for (const id of summary.applied) {
      const row = await getDbAsSystem().get(migrationTable, { id });
      expect(row.status).toBe('success');
      expect(row.output).toBe(`${id} output`);
    }
  }, 60000);

  test('a manual migration is excluded from the series but keeps the Migrations-page flow', async () => {
    // Manual and OLDEST — exclusion must come from the flag, not from ordering luck.
    const manual = plantMigration('manual-backfill', { manual: true } as Partial<Migration>);
    const automated = plantMigration('automated-after-manual');
    await insertLedgerRow(manual, 0);
    await insertLedgerRow(automated, 1);

    const summary = await new MigrationRunner().runPendingMigrations();

    expect(runLog).toEqual(['automated-after-manual']);
    expect(summary.skippedManual).toEqual(['manual-backfill']);
    expect(summary.applied).toEqual(['automated-after-manual']);
    const manualRow = await getDbAsSystem().get(migrationTable, { id: 'manual-backfill' });
    expect(manualRow.status).toBe('proposed');

    // The page flow still runs it: the flag excludes from the auto-series, it does not disable.
    registerTestUser();
    try {
      await new MigrationRunner().runMigration('manual-backfill');
    } finally {
      clearTestUser();
    }
    expect(runLog).toEqual(['automated-after-manual', 'manual-backfill']);
    const ranManualRow = await getDbAsSystem().get(migrationTable, { id: 'manual-backfill' });
    expect(ranManualRow.status).toBe('success');
  }, 60000);

  test('the first failure stops the series; the next series retries it and finishes the tail', async () => {
    let bFixed = false;
    const a = plantMigration('fail-a-ok');
    const b = plantMigration('fail-b-boom', {
      run: async () => {
        if (!bFixed) {
          throw new Error('b blew up mid-run');
        }
        runLog.push('fail-b-boom');
        return 'b fixed output';
      },
    } as Partial<Migration>);
    const c = plantMigration('fail-c-after');
    await insertLedgerRow(a, 0);
    await insertLedgerRow(b, 1);
    await insertLedgerRow(c, 2);

    const firstSeries = await new MigrationRunner().runPendingMigrations();

    // a ran, b failed, c never started — the deploy gate's failure surface.
    expect(runLog).toEqual(['fail-a-ok']);
    expect(firstSeries.applied).toEqual(['fail-a-ok']);
    expect(firstSeries.failed).toEqual({
      id: 'fail-b-boom',
      description: 'pending-series test migration fail-b-boom',
      failureMessage: 'b blew up mid-run',
    });
    expect(firstSeries.notAttempted).toEqual(['fail-c-after']);
    expect((await getDbAsSystem().get(migrationTable, { id: 'fail-b-boom' })).status).toBe('failure');
    expect((await getDbAsSystem().get(migrationTable, { id: 'fail-c-after' })).status).toBe('proposed');

    // The "fixed migration ships, deploy re-runs" path: b retried, c finally runs, a skipped.
    bFixed = true;
    const secondSeries = await new MigrationRunner().runPendingMigrations();

    expect(runLog).toEqual(['fail-a-ok', 'fail-b-boom', 'fail-c-after']);
    expect(secondSeries.applied).toEqual(['fail-b-boom', 'fail-c-after']);
    expect(secondSeries.alreadyApplied).toEqual(['fail-a-ok']);
    expect(secondSeries.failed).toBeUndefined();
    expect((await getDbAsSystem().get(migrationTable, { id: 'fail-c-after' })).status).toBe('success');
  }, 60000);

  test('ledger rows without a source record are stamped retired — skipped, reported, never run', async () => {
    const live = plantMigration('live-beside-history');
    await insertLedgerRow(live, 1);
    // A row whose loader was deleted after it ran in some past release
    // (doNotDeleteSourceRecordsFromDb keeps it in the ledger forever).
    await getDbAsSystem().insert(migrationTable, {
      id: 'ghost-history',
      description: 'loader deleted after an old release ran it',
      created: moment(base),
    } as any);

    const summary = await new MigrationRunner().runPendingMigrations();

    expect(summary.unresolved).toEqual(['ghost-history']);
    expect(summary.retired).toEqual([]);
    expect(summary.applied).toEqual(['live-beside-history']);
    expect(summary.failed).toBeUndefined();
    const ghostRow = await getDbAsSystem().get(migrationTable, { id: 'ghost-history' });
    expect(ghostRow.status).toBe('proposed');
    // The stamp: an unresolved row is retired on sight, so a returning source class can never
    // silently re-arm it (the pin for that refusal is the next test).
    expect(ghostRow.retired).toBe(true);
  }, 60000);

  test('a stamped row is refused even when its source class ships again — the flag outlives the gap', async () => {
    // Gate run over a build where the row's loader no longer ships: the run stamps it retired.
    await getDbAsSystem().insert(migrationTable, {
      id: 'returning-loader',
      description: 'loader missing from this build',
      created: moment(base),
    } as any);
    const stampingRun = await new MigrationRunner().runPendingMigrations();
    expect(stampingRun.unresolved).toEqual(['returning-loader']);

    // The source class RETURNS in a later build. Its id resolving again is not consent to
    // auto-run: the row stays excluded until a human un-retires it on the Migrations page.
    plantMigration('returning-loader');
    const laterRun = await new MigrationRunner().runPendingMigrations();

    expect(runLog).toEqual([]);
    expect(laterRun.retired).toEqual(['returning-loader']);
    expect(laterRun.unresolved).toEqual([]);
    expect(laterRun.applied).toEqual([]);
    const row = await getDbAsSystem().get(migrationTable, { id: 'returning-loader' });
    expect(row.retired).toBe(true);
    expect(row.status).toBe('proposed');
  }, 60000);

  test('un-retiring a retired row re-arms the series — it runs to success', async () => {
    const migration = plantMigration('unretired-comeback');
    await getDbAsSystem().insert(migrationTable, {
      ...migration,
      retired: true,
      created: moment(base),
    } as any);

    const refusedRun = await new MigrationRunner().runPendingMigrations();
    expect(runLog).toEqual([]);
    expect(refusedRun.retired).toEqual(['unretired-comeback']);

    // The Migrations-page Un-retire button issues exactly this write.
    await getDbAsSystem().update(migrationTable, { id: 'unretired-comeback', retired: false } as any);
    const rearmedRun = await new MigrationRunner().runPendingMigrations();

    expect(runLog).toEqual(['unretired-comeback']);
    expect(rearmedRun.applied).toEqual(['unretired-comeback']);
    expect(rearmedRun.retired).toEqual([]);
    const row = await getDbAsSystem().get(migrationTable, { id: 'unretired-comeback' });
    expect(row.status).toBe('success');
    expect(row.output).toBe('unretired-comeback output');
    expect(row.retired).toBe(false);
  }, 60000);
});
