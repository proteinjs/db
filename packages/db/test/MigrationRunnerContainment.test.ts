import { MigrationRunner } from '../src/MigrationRunner';
import { Migration, MigrationTable } from '../src/tables/MigrationTable';
import { SourceRecordRepo } from '../src/source/SourceRecordRepo';

/**
 * MigrationRunnerService is dispatched fire-and-forget (`doNotAwait`): ServiceExecutor calls
 * runMigration WITHOUT awaiting and its try/catch sees only SYNCHRONOUS throws. Any rejection
 * of the returned promise is an unhandled promise rejection — node's default kills the whole
 * server process — and the service is reachable by every 'dev'-permission holder since
 * migrations moved off admin.
 *
 * MigrationRunner therefore owns containment on both sides of the dispatch seam:
 * - everything knowable BEFORE the run starts (a bogus id) throws synchronously, the only
 *   path on which an error can still reach the client (executor wraps it -> 400);
 * - the detached async body NEVER rejects: migration.run() failures record failure status on
 *   the migration record (pinned on the emulator in @proteinjs/db-driver-spanner's
 *   MigrationRunner.test.ts), and failures of recording run state itself are logged
 *   terminally.
 */
describe('MigrationRunner containment (doNotAwait dispatch)', () => {
  it('throws synchronously on a bogus migration id, not through the detached promise', () => {
    const runner = new MigrationRunner();
    expect(() => runner.runMigration('bogus-migration-id')).toThrow(
      'Unable to find migration source record for id: bogus-migration-id'
    );
  });

  it('resolves (never rejects) when the detached body hits a mid-run infrastructure failure', async () => {
    // This harness registers no DefaultDbDriverFactory, so the body's first db access throws —
    // the same shape as any mid-run infrastructure failure (db.update rejecting). Pre-fix this
    // rejection escaped the fire-and-forget dispatch as an unhandled rejection.
    const migrationTable = new MigrationTable();
    const migration = {
      id: 'containment-test-migration',
      description: 'containment test migration',
      run: async () => undefined,
    } as Migration;
    new SourceRecordRepo().loadSourceRecord(migrationTable.name, migration);

    const runner = new MigrationRunner();
    await expect(runner.runMigration('containment-test-migration')).resolves.toBeUndefined();
  });
});
