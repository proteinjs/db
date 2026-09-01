import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import {
  getDb,
  getDbAsSystem,
  Migration,
  MigrationRunner,
  MigrationTable,
  SourceRecordRepo,
  Table,
} from '@proteinjs/db';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * MigrationRunner over the real stack: Spanner emulator, default-driver resolution via
 * reflection — the same `getDb()` path production takes inside the runner.
 *
 * These pin the runner's domain bookkeeping: a migration that throws mid-run is a run OUTCOME —
 * the detached promise RESOLVES and failure status lands on the record; a successful one records
 * success and its output. Only infrastructure failures (recording run state itself) reject the
 * promise, and on the service path the executor terminally observes those (@proteinjs/service
 * ServiceExecutor; MigrationRunnerContainment.test.ts in @proteinjs/db pins the seam).
 */

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

describe('MigrationRunner (spanner)', () => {
  const migrationTable = new MigrationTable() as Table<Migration>;
  const dropTable = getDropTestTable(spannerDriver);
  const sourceRecordRepo = new SourceRecordRepo();

  const failingMigration = {
    id: 'migration-runner-test-failing',
    description: 'fails mid-run',
    run: async () => {
      throw new Error('migration blew up mid-run');
    },
  } as unknown as Migration;

  const succeedingMigration = {
    id: 'migration-runner-test-succeeding',
    description: 'succeeds',
    run: async () => 'migration output',
  } as unknown as Migration;

  // #124 wedge class: optional run-state fields are legitimately ABSENT (a void run() leaves no
  // output; a non-Error throw has no message/stack), and the completion write must omit them —
  // an undefined-valued field fails the WHOLE write (RecordSerializer rejects it), stranding the
  // row at 'running' with the run's real outcome lost.
  let voidRunCount = 0; // effect counter: proves the run itself completed
  const voidOutputMigration = {
    id: 'migration-runner-test-void-output',
    description: 'resolves void — no output',
    run: async () => {
      voidRunCount++;
    },
  } as unknown as Migration;

  const nonErrorThrowMigration = {
    id: 'migration-runner-test-string-throw',
    description: 'throws a non-Error value',
    run: async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'string throw with no message or stack';
    },
  } as unknown as Migration;

  // ensureMigrationRun fixtures carry run counters: re-running any of them is VISIBLE as a
  // counter increment, so idempotence and retry are asserted on the migration's own effect,
  // not on bookkeeping interactions.
  let ensureBootRunCount = 0;
  const ensureBootMigration = {
    id: 'migration-runner-test-ensure-boot',
    description: 'runs at boot with no user session',
    run: async () => {
      ensureBootRunCount++;
      return 'boot output';
    },
  } as unknown as Migration;

  let ensureIdempotentRunCount = 0;
  const ensureIdempotentMigration = {
    // Ids stay <= 36 chars — the migration table's id column is uuid-width.
    id: 'migration-runner-test-ensure-skip',
    description: 'must not re-run once successful',
    run: async () => {
      ensureIdempotentRunCount++;
      return 'idempotent output';
    },
  } as unknown as Migration;

  let ensureRetryAttempts = 0;
  const ensureRetriedMigration = {
    id: 'migration-runner-test-ensure-retried',
    description: 'fails first, fixed on retry',
    run: async () => {
      ensureRetryAttempts++;
      if (ensureRetryAttempts === 1) {
        throw new Error('ensure migration blew up mid-run');
      }
      return 'fixed on retry';
    },
  } as unknown as Migration;

  beforeAll(async () => {
    // Explicit admin identity (UserAuth is fail-closed): the migration table's doors ride the
    // 'dev' permission with admin break-glass — the permission mapping itself is pinned in
    // @proteinjs/db's MigrationAuth suite.
    registerTestUser();
    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    await dropTable(migrationTable);
    await spannerDriver.getTableManager().loadTable(migrationTable);
    for (const migration of [
      failingMigration,
      succeedingMigration,
      voidOutputMigration,
      nonErrorThrowMigration,
      ensureBootMigration,
      ensureIdempotentMigration,
      ensureRetriedMigration,
    ]) {
      sourceRecordRepo.loadSourceRecord(migrationTable.name, migration);
      // Seed through the door the product actually births ledger rows through: the boot-time
      // source sync rides getDbAsSystem (SourceRecordLoader), and the migration table declares
      // NO caller-path insert door — for anyone, break-glass included (the runner only ever
      // UPDATES run state as the caller). The RunPendingMigrations suite seeds the same way.
      await getDbAsSystem().insert(migrationTable, migration);
    }
  }, 60000);

  afterAll(async () => {
    clearTestUser();
    await dropTable(migrationTable);
    SpannerEmulatorProvisioner.release();
  }, 30000);

  test('a mid-run throw resolves the detached promise and records failure status', async () => {
    const runner = new MigrationRunner();
    await expect(runner.runMigration(failingMigration.id)).resolves.toBeUndefined();

    const row = await getDb().get(migrationTable, { id: failingMigration.id });
    expect(row.status).toBe('failure');
    expect(row.failureMessage).toBe('migration blew up mid-run');
    expect(row.failureStack).toContain('migration blew up mid-run');
    expect(row.duration).toBeTruthy();
  });

  test('a successful migration records success and its output', async () => {
    const runner = new MigrationRunner();
    await expect(runner.runMigration(succeedingMigration.id)).resolves.toBeUndefined();

    const row = await getDb().get(migrationTable, { id: succeedingMigration.id });
    expect(row.status).toBe('success');
    expect(row.output).toBe('migration output');
    expect(row.duration).toBeTruthy();
  });

  test('a void migration (no output) records success — absent fields are omitted from the completion write', async () => {
    const runner = new MigrationRunner();
    await expect(runner.runMigration(voidOutputMigration.id)).resolves.toBeUndefined();

    expect(voidRunCount).toBe(1);
    const row = await getDb().get(migrationTable, { id: voidOutputMigration.id });
    expect(row.status).toBe('success');
    expect(row.output == null).toBe(true);
    expect(row.duration).toBeTruthy();
  });

  test('a non-Error throw records failure — absent failureMessage/failureStack never poison the write', async () => {
    const runner = new MigrationRunner();
    await expect(runner.runMigration(nonErrorThrowMigration.id)).resolves.toBeUndefined();

    const row = await getDb().get(migrationTable, { id: nonErrorThrowMigration.id });
    expect(row.status).toBe('failure');
    expect(row.failureMessage == null).toBe(true);
    expect(row.duration).toBeTruthy();
  });

  describe('ensureMigrationRun (boot path)', () => {
    // Boot context: NO user session exists — UserAuth is fail-closed, so any getDb() bookkeeping
    // would deny. These tests run with the suite's test identity CLEARED to pin that
    // ensureMigrationRun records through the system db. Assertions read as system for the same
    // reason; the identity is restored for the rest of the suite (afterAll drops the table via
    // getDb-adjacent paths).
    beforeEach(() => clearTestUser());
    afterEach(() => registerTestUser());

    test('runs a pending migration with no user session and records success', async () => {
      const runner = new MigrationRunner();
      await runner.ensureMigrationRun(ensureBootMigration.id);

      expect(ensureBootRunCount).toBe(1);
      const row = await getDbAsSystem().get(migrationTable, { id: ensureBootMigration.id });
      expect(row.status).toBe('success');
      expect(row.output).toBe('boot output');
      expect(row.duration).toBeTruthy();
    });

    test('a second call skips an already-successful migration', async () => {
      const runner = new MigrationRunner();
      await runner.ensureMigrationRun(ensureIdempotentMigration.id);
      expect(ensureIdempotentRunCount).toBe(1);

      await runner.ensureMigrationRun(ensureIdempotentMigration.id);

      // The migration's effect did not repeat — 'ensure' skipped the successful row.
      expect(ensureIdempotentRunCount).toBe(1);
      const row = await getDbAsSystem().get(migrationTable, { id: ensureIdempotentMigration.id });
      expect(row.status).toBe('success');
    });

    test('a throwing migration records failure and is retried by the next call', async () => {
      const runner = new MigrationRunner();
      await runner.ensureMigrationRun(ensureRetriedMigration.id);

      expect(ensureRetryAttempts).toBe(1);
      const failedRow = await getDbAsSystem().get(migrationTable, { id: ensureRetriedMigration.id });
      expect(failedRow.status).toBe('failure');
      expect(failedRow.failureMessage).toBe('ensure migration blew up mid-run');

      await runner.ensureMigrationRun(ensureRetriedMigration.id);

      expect(ensureRetryAttempts).toBe(2);
      const retriedRow = await getDbAsSystem().get(migrationTable, { id: ensureRetriedMigration.id });
      expect(retriedRow.status).toBe('success');
      expect(retriedRow.output).toBe('fixed on retry');
    });
  });
});
