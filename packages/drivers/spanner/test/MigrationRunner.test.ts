import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { getDb, Migration, MigrationRunner, MigrationTable, SourceRecordRepo, Table } from '@proteinjs/db';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * MigrationRunner over the real stack: Spanner emulator, default-driver resolution via
 * reflection — the same `getDb()` path production takes inside the runner.
 *
 * The service dispatches runMigration fire-and-forget (`doNotAwait`), so the pinned outcomes
 * double as process-liveness proof: a rejection of the detached promise would surface as an
 * unhandled promise rejection and kill the server process. A migration that throws mid-run
 * must RESOLVE and record failure status on its record; a successful one records success and
 * its output.
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
    for (const migration of [failingMigration, succeedingMigration]) {
      sourceRecordRepo.loadSourceRecord(migrationTable.name, migration);
      await getDb().insert(migrationTable, migration);
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
});
