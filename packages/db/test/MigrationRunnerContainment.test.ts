// EnvInfo.isDev() requires a GlobalDataStorage implementation that only exists in a running app
// (same mock the @proteinjs/service executor suite uses).
jest.mock('@proteinjs/server-api', () => ({
  EnvInfo: { isDev: () => true },
}));

import { Logger, Log, DefaultLogWriter } from '@proteinjs/logger';
import { Interface, Method } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
// Deep dist path on purpose: the package index doesn't export the executor (framework plumbing),
// but the executor check below must run the REAL BUILT owner of the doNotAwait seam.
import { ServiceExecutor } from '@proteinjs/service/dist/src/ServiceExecutor';
import { MigrationRunner } from '../src/MigrationRunner';
import { Migration, MigrationTable } from '../src/tables/MigrationTable';
import { SourceRecordRepo } from '../src/source/SourceRecordRepo';
import { registerTestUser, clearTestUser } from './util/testUser';

/**
 * MigrationRunnerService is dispatched fire-and-forget (`doNotAwait`): ServiceExecutor calls
 * runMigration WITHOUT awaiting, so its try/catch sees only SYNCHRONOUS throws and the detached
 * promise's rejections are terminally observed by the executor itself (service c16645d — logged
 * with method identity, never an unhandled rejection).
 *
 * MigrationRunner's own contract along that seam:
 * - everything knowable BEFORE the run starts (a bogus id) throws synchronously, the only
 *   path on which an error can still reach the client (executor wraps it -> 400);
 * - migration.run() failures are run OUTCOMES, recorded as failure status on the migration
 *   record (pinned on the emulator in @proteinjs/db-driver-spanner's MigrationRunner.test.ts);
 * - infrastructure failures (recording run state itself) REJECT the returned promise — the
 *   caller owns them. On the service path that caller is the executor.
 */

type ExecutorInternals = { logger: Logger };

/**
 * This harness loads no reflection graph and registers no DefaultDbDriverFactory, so the body's
 * FIRST db access (`new Db()` constructing its table-watcher runner) throws this. The specific
 * message is a harness accident standing in for any mid-run infrastructure failure (db.update
 * rejecting); the contract under test is that the failure escapes as a rejection at all.
 */
const infrastructureFailure = 'Unable to find type: @proteinjs/db/TableWatcher';

const plantMigration = (id: string): Migration => {
  const migration = {
    id,
    description: 'containment test migration',
    run: async () => undefined,
  } as Migration;
  new SourceRecordRepo().loadSourceRecord(new MigrationTable().name, migration);
  return migration;
};

describe('MigrationRunner containment (doNotAwait dispatch)', () => {
  it('throws synchronously on a bogus migration id, not through the detached promise', () => {
    const runner = new MigrationRunner();
    expect(() => runner.runMigration('bogus-migration-id')).toThrow(
      'Unable to find migration source record for id: bogus-migration-id'
    );
  });

  it('rejects the detached promise on a mid-run infrastructure failure — the caller owns it', async () => {
    // The runner no longer swallows infrastructure failures: the rejection escapes to whoever
    // holds the promise.
    plantMigration('containment-test-migration');

    const runner = new MigrationRunner();
    await expect(runner.runMigration('containment-test-migration')).rejects.toThrow(infrastructureFailure);
  });

  it('through the real built executor, an infrastructure-failure rejection is terminally logged — not process death', async () => {
    // Admin identity passes the service's 'dev' permission as break-glass (MigrationAuth.test.ts
    // pins the mapping itself).
    registerTestUser();
    try {
      plantMigration('containment-test-migration-executor');

      const runner = new MigrationRunner();
      const method = new Method('runMigration', undefined, true, false, false, false, 'public', []);
      const _interface = new Interface('@proteinjs/db', 'MigrationRunnerService', [], [method]);
      const executor = new ServiceExecutor(runner, _interface, method);
      const entries: Log[] = [];
      (executor as unknown as ExecutorInternals).logger = new Logger({
        name: 'MigrationRunnerService.runMigration',
        logWriter: { write: (log: Log) => entries.push(log) } as unknown as DefaultLogWriter,
      });

      // The client response does not carry the failure — execute resolves immediately.
      await expect(
        executor.execute(Serializer.serialize(['containment-test-migration-executor']))
      ).resolves.toBeUndefined();
      // The detached rejection settles after the microtask queue drains; flush macrotasks so the
      // executor's terminal catch has written its log entry. Were the rejection unobserved, jest
      // would surface it as a failure here — and a bare node process would die.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const errorEntry = entries.find((entry) => entry.logLevel === 'error');
      expect(errorEntry?.error?.message).toContain(infrastructureFailure);
      expect(errorEntry?.obj?.functionName).toBe('MigrationRunnerService.runMigration');
    } finally {
      clearTestUser();
    }
  });
});
