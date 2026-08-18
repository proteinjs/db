import { SourceRepository } from '@proteinjs/reflection';
import {
  Db,
  DbDriver,
  DuplicateValuesForUniqueIndexError,
  SourceRecord,
  SourceRecordRepo,
  StringColumn,
  Table,
  TableWatcher,
  getDbAsSystem,
  withSourceRecordColumns,
} from '@proteinjs/db';
import type { DefaultTransactionContextFactory } from '@proteinjs/db';
// Relative on purpose: the class shares its name with the SourceRecordLoader declaration
// interface exported from the package index, so it is not index-exported.
import { SourceRecordLoader } from '../../src/source/SourceRecordLoader';
import { TableWatcherRunner } from '../../src/TableWatcherRunner';
import { DbTestEnvironment } from '../util/DbTestEnvironment';
import {
  DupePreflightTable,
  DupePreflightUniqueEmailTable,
  SyncMachineAccount,
  sourceRecordSyncTestTables,
} from '../util/tables/sourceRecordSyncTestTables';

type SourceRepositoryInternals = { objectCache: { [qualifiedName: string]: unknown[] } };
type DbStatics = { defaultDbDriver?: DbDriver };
type TableWatcherRunnerStatics = { tableWatcherMap?: unknown };

/** Records afterUpdate payloads on the machine table — the watcher-visibility contract probe. */
class RecordingMachineAccountWatcher implements TableWatcher<SyncMachineAccount> {
  static updates: Partial<SyncMachineAccount>[] = [];

  name(): string {
    return this.constructor.name;
  }

  table(): Table<SyncMachineAccount> {
    return sourceRecordSyncTestTables.SyncMachineAccount;
  }

  async afterUpdate<T extends SyncMachineAccount>(recordUpdateCount: number, record: Partial<T>): Promise<void> {
    RecordingMachineAccountWatcher.updates.push({ ...record });
  }
}

/**
 * Emulator-backed outcome tests for the source-record sync's mixed-table semantics:
 * declare-only ownership (human rows structurally untouchable), natural-key adoption
 * (existing row keeps its id and runtime fields), `onSourceRemoved` policies (flag-not-delete
 * through `Db.update` so watchers fire; default delete unchanged), boot-time natural-key
 * validation, and the unique-index duplicate preflight.
 */
export const sourceRecordSyncTests = (
  driver: DbDriver,
  transactionContextFactory: DefaultTransactionContextFactory,
  dropTable: (table: Table<any>) => Promise<void>
) => {
  return () => {
    const testEnv = new DbTestEnvironment(driver, dropTable);
    const machineTable = sourceRecordSyncTestTables.SyncMachineAccount;
    const defaultPolicyTable = sourceRecordSyncTestTables.SyncDefaultPolicy;
    const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;
    let originalWatchers: unknown[] | undefined;

    /** Seed the boot declarations and run the sync — one boot of `Db.init`'s loader leg. */
    const boot = async (declarations: { table: Table<any>; record: any }[]) => {
      objectCache()['@proteinjs/db/SourceRecordLoader'] = declarations;
      await new SourceRecordLoader().load();
    };

    const machineDeclaration = (record: Partial<SyncMachineAccount> & { id: string; email: string }) => ({
      table: machineTable,
      record: { status: 'active', ...record },
    });

    const machineRows = async (query: Partial<SyncMachineAccount> = {}) =>
      await getDbAsSystem().query(machineTable, query);

    beforeAll(async () => {
      // The suite drives the loader exactly the way Db.init does — through the DEFAULT driver —
      // so the driver under test must be the resolvable default (and any previously cached
      // default must not leak in from earlier suites in this process).
      objectCache()['@proteinjs/db/DefaultDbDriverFactory'] = [{ getDbDriver: () => driver }];
      objectCache()['@proteinjs/db/DefaultTransactionContextFactory'] = [transactionContextFactory];
      (Db as unknown as DbStatics).defaultDbDriver = undefined;
      // Only the recording watcher observes this run — and the runner's static map must be
      // rebuilt from the seeded cache rather than whatever an earlier Db construction cached.
      originalWatchers = objectCache()['@proteinjs/db/TableWatcher'];
      objectCache()['@proteinjs/db/TableWatcher'] = [new RecordingMachineAccountWatcher()];
      (TableWatcherRunner as unknown as TableWatcherRunnerStatics).tableWatcherMap = undefined;
      await testEnv.beforeAll();
    }, 60000);

    afterAll(async () => {
      await testEnv.afterAll();
      delete objectCache()['@proteinjs/db/SourceRecordLoader'];
      delete objectCache()['@proteinjs/db/DefaultDbDriverFactory'];
      delete objectCache()['@proteinjs/db/DefaultTransactionContextFactory'];
      if (originalWatchers) {
        objectCache()['@proteinjs/db/TableWatcher'] = originalWatchers;
      } else {
        delete objectCache()['@proteinjs/db/TableWatcher'];
      }
      (TableWatcherRunner as unknown as TableWatcherRunnerStatics).tableWatcherMap = undefined;
      (Db as unknown as DbStatics).defaultDbDriver = undefined;
    }, 60000);

    beforeEach(async () => {
      const db = getDbAsSystem();
      await db.delete(machineTable, {});
      await db.delete(defaultPolicyTable, {});
      RecordingMachineAccountWatcher.updates = [];
    });

    test('declare-only on a mixed table: declared records insert; human rows are untouched', async () => {
      const db = getDbAsSystem();
      const human = await db.insert(machineTable, {
        email: 'human@test.local',
        displayName: 'A human',
        runtimeNote: 'human-owned',
      });

      await boot([machineDeclaration({ id: 'machine-1', email: 'machine@test.local', displayName: 'Machine' })]);

      const machine = await db.get(machineTable, { email: 'machine@test.local' });
      expect(machine).toMatchObject({
        id: 'machine-1',
        displayName: 'Machine',
        status: 'active',
        isLoadedFromSource: true,
      });

      // The human row survives the boot byte-for-byte: not deleted, not flagged, fields intact.
      const humanAfter = await db.get(machineTable, { id: human.id });
      expect(humanAfter).toBeDefined();
      expect(humanAfter.isLoadedFromSource).toBeFalsy();
      expect(humanAfter).toMatchObject({ displayName: 'A human', runtimeNote: 'human-owned' });
      expect(humanAfter.status).toBeFalsy();
      expect(await machineRows()).toHaveLength(2);
    });

    test('declared fields revert on boot; runtime-owned fields survive; converged boots write nothing', async () => {
      const declarations = [
        machineDeclaration({ id: 'machine-1', email: 'machine@test.local', displayName: 'Machine' }),
      ];
      await boot(declarations);

      // Runtime drift on a declared field + a runtime-owned write (the credential stand-in).
      const db = getDbAsSystem();
      await db.update(machineTable, { id: 'machine-1', displayName: 'Drifted', runtimeNote: 'provisioned' });

      await boot(declarations);
      const reverted = await db.get(machineTable, { id: 'machine-1' });
      expect(reverted).toMatchObject({ displayName: 'Machine', runtimeNote: 'provisioned' });

      // A converged boot is a no-op: the row's `updated` stamp does not churn.
      const stampBefore = reverted.updated.valueOf();
      await boot(declarations);
      const afterIdleBoot = await db.get(machineTable, { id: 'machine-1' });
      expect(afterIdleBoot.updated.valueOf()).toBe(stampBefore);
    });

    test('natural-key adoption: an existing row is adopted in place — id and runtime fields preserved', async () => {
      const db = getDbAsSystem();
      // The hand-made bridge row: env-random id, runtime-provisioned fields, never flagged.
      const handMade = await db.insert(machineTable, {
        email: 'bridge@test.local',
        displayName: 'Hand-made bridge',
        runtimeNote: 'the-password-hash',
      });

      await boot([machineDeclaration({ id: 'declared-id', email: 'bridge@test.local', displayName: 'Ops bridge' })]);

      const rows = await machineRows({ email: 'bridge@test.local' });
      expect(rows).toHaveLength(1);
      // Adopted: the existing id survives (scoped rows reference it); declared fields reverted;
      // runtime fields (the credential) preserved; the row is now source-owned.
      expect(rows[0]).toMatchObject({
        id: handMade.id,
        displayName: 'Ops bridge',
        status: 'active',
        runtimeNote: 'the-password-hash',
        isLoadedFromSource: true,
      });
      expect(await db.get(machineTable, { id: 'declared-id' })).toBeUndefined();

      // The in-process repo registers the record under the ADOPTED id, not the declared one.
      expect(new SourceRecordRepo().getSourceRecord(machineTable.name, handMade.id)).toBeDefined();
      expect(new SourceRecordRepo().getSourceRecord(machineTable.name, 'declared-id')).toBeUndefined();

      // Adoption converges: the id difference is not perpetual drift.
      const stampBefore = rows[0].updated.valueOf();
      await boot([machineDeclaration({ id: 'declared-id', email: 'bridge@test.local', displayName: 'Ops bridge' })]);
      const afterIdleBoot = await db.get(machineTable, { id: handMade.id });
      expect(afterIdleBoot.updated.valueOf()).toBe(stampBefore);
    });

    test('onSourceRemoved update: removed rows are flagged through Db.update (watchers fire), never deleted; re-declaring reverts', async () => {
      const db = getDbAsSystem();
      const human = await db.insert(machineTable, { email: 'human@test.local', displayName: 'A human' });
      await boot([machineDeclaration({ id: 'machine-1', email: 'machine@test.local' })]);

      RecordingMachineAccountWatcher.updates = [];
      await boot([]);

      const removed = await db.get(machineTable, { id: 'machine-1' });
      expect(removed).toBeDefined();
      expect(removed.status).toBe('deactivated');
      expect(removed.isLoadedFromSource).toBe(true);
      // The write went through Db.update — table watchers observed the deactivation.
      expect(RecordingMachineAccountWatcher.updates).toHaveLength(1);
      expect(RecordingMachineAccountWatcher.updates[0]).toMatchObject({ id: 'machine-1', status: 'deactivated' });
      // The human row is structurally out of reach of the removed reconcile.
      expect((await db.get(machineTable, { id: human.id })).status).toBeFalsy();

      // Idempotent: an already-flagged row is not re-written on the next boot.
      RecordingMachineAccountWatcher.updates = [];
      await boot([]);
      expect(RecordingMachineAccountWatcher.updates).toHaveLength(0);

      // Removal is reversible in source: re-declaring reverts the patch via drift reversion.
      await boot([machineDeclaration({ id: 'machine-1', email: 'machine@test.local' })]);
      expect((await db.get(machineTable, { id: 'machine-1' })).status).toBe('active');
    });

    test(`onSourceRemoved default: removed source rows are deleted; human rows survive`, async () => {
      const db = getDbAsSystem();
      const human = await db.insert(defaultPolicyTable, { email: 'human@test.local' });
      await boot([{ table: defaultPolicyTable, record: { id: 'default-1', email: 'temp@test.local' } }]);
      expect(await db.get(defaultPolicyTable, { id: 'default-1' })).toBeDefined();

      await boot([]);
      expect(await db.get(defaultPolicyTable, { id: 'default-1' })).toBeUndefined();
      expect(await db.get(defaultPolicyTable, { id: human.id })).toBeDefined();
    });

    test('a natural key without a unique guarantee fails boot loudly', async () => {
      // Local (unregistered, never created) on purpose: a registered table with an invalid
      // naturalKey would poison every loader run in the process — validation fires before any
      // db access, so the schema is never needed.
      interface Misdeclared extends SourceRecord {
        nickname: string;
      }
      class MisdeclaredNaturalKeyTable extends Table<Misdeclared> {
        name = 'db_test_sync_misdeclared_natural_key';
        columns = withSourceRecordColumns<Misdeclared>({ nickname: new StringColumn('nickname') });
        sourceRecordOptions = { naturalKey: 'nickname' } as Table<Misdeclared>['sourceRecordOptions'];
      }

      await expect(
        boot([{ table: new MisdeclaredNaturalKeyTable(), record: { id: 'm-1', nickname: 'dupe-prone' } }])
      ).rejects.toThrow(/naturalKey 'nickname' requires the column to be unique/);
    });

    test('two declarations sharing a natural key fail boot loudly', async () => {
      await expect(
        boot([
          machineDeclaration({ id: 'machine-1', email: 'shared@test.local' }),
          machineDeclaration({ id: 'machine-2', email: 'shared@test.local' }),
        ])
      ).rejects.toThrow(/share the natural key 'email' = 'shared@test.local'/);
    });

    test('unique-index preflight: adding a unique index over duplicate data fails by name; clean data proceeds', async () => {
      const tableManager = driver.getTableManager();
      const generationOne = new DupePreflightTable();
      const generationTwo = new DupePreflightUniqueEmailTable();
      try {
        await tableManager.loadTable(generationOne);
        const db = getDbAsSystem();
        const first = await db.insert(generationOne, { email: 'dupe@test.local' });
        await db.insert(generationOne, { email: 'dupe@test.local' });

        // The pre-sync duplicate check turns the opaque index-backfill failure into a named error.
        await expect(tableManager.loadTable(generationTwo)).rejects.toThrow(DuplicateValuesForUniqueIndexError);
        await expect(tableManager.loadTable(generationTwo)).rejects.toThrow(/dupe@test\.local/);

        // Resolve the duplicates and the same boot proceeds.
        await db.delete(generationOne, { id: first.id });
        await tableManager.loadTable(generationTwo);
      } finally {
        await dropTable(generationOne);
      }
    });
  };
};
