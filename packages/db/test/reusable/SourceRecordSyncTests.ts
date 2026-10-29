import { SourceRepository } from '@proteinjs/reflection';
import {
  Db,
  DbDriver,
  DuplicateValuesForUniqueIndexError,
  SOURCE_RECORD_EXPORT_PERMISSION,
  SourceRecord,
  SourceRecordDeclarationBundle,
  SourceRecordDeclarationDocument,
  SourceRecordExport,
  SourceRecordRepo,
  StringColumn,
  Table,
  TableWatcher,
  getDbAsSystem,
  getSourceRecordTables,
  isSourceRecordTable,
  withSourceRecordColumns,
} from '@proteinjs/db';
import type { DefaultTransactionContextFactory } from '@proteinjs/db';
import { SourceRecordSyncRunner } from '../../source/SourceRecordSyncRunner';
import { TableWatcherRunner } from '../../src/TableWatcherRunner';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import moment from 'moment';
import { DbTestEnvironment } from '../util/DbTestEnvironment';
import {
  DupePreflightTable,
  DupePreflightUniqueEmailTable,
  SyncMachineAccount,
  SyncScopedEntry,
  SyncSoftRemovedWidget,
  SyncWidget,
  sourceRecordSyncTestTables,
} from '../util/tables/sourceRecordSyncTestTables';

type SourceRepositoryInternals = {
  objectCache: { [qualifiedName: string]: unknown[] };
  namedObjectCache: { [qualifiedName: string]: { qualifiedName: string; packageName: string; object: unknown }[] };
};
type LoaderInternals = { resolveSourceVersion: (source: string) => string | undefined };
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
 * declare-only ownership (human rows structurally untouchable), the authorship precedence (the
 * sync's stamp tells its own rows from the product's; a row the product edited on a declared
 * column is never touched while the declaration stands still, re-adopted when the declaration
 * equals it, and a two-sided divergence is counted and warned), natural-key sync (an owned row
 * keeps its id and runtime fields; a row the sync does not own refuses the declaration and is
 * never taken over), `onSourceRemoved` policies (flag-not-delete through `Db.update` so
 * watchers fire; default delete unchanged), the removal guard, declaration files as a source
 * (with the row filter and an external column's sibling files), the export door, the scoped
 * key, boot-time natural-key validation, and the unique-index duplicate preflight.
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
    const namedObjectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).namedObjectCache;
    let originalWatchers: unknown[] | undefined;

    /** The single source most of the suite boots as (multi-source tests name their own). */
    const DEFAULT_TEST_SOURCE = '@test/source-a';

    /**
     * One boot of the loader leg as a BUILD: each declaration owned by its declaring package
     * (`source`), seeded through the named-object cache the loader resolves declarations (and
     * their owning packages) from. `versions` pins each package's version for the boot (the
     * loader's version resolution is overridden — a package absent from the map is versionless,
     * matching a build whose package.json could not be resolved).
     */
    const bootBuild = async (
      declarations: { source: string; table: Table<any>; record: any }[],
      versions: { [source: string]: string | undefined } = {}
    ) => {
      namedObjectCache()['@proteinjs/db/SourceRecordLoader'] = declarations.map((declaration, i) => ({
        qualifiedName: `${declaration.source}/SeededLoader${i}`,
        packageName: declaration.source,
        object: { table: declaration.table, record: declaration.record },
      }));
      const loader = new SourceRecordSyncRunner();
      (loader as unknown as LoaderInternals).resolveSourceVersion = (source) =>
        Object.prototype.hasOwnProperty.call(versions, source) ? versions[source] : undefined;
      return await loader.load();
    };

    /** One boot of the loader leg as a build declaring everything from a single package. */
    const bootAsSource = async (source: string, declarations: { table: Table<any>; record: any }[], version?: string) =>
      await bootBuild(
        declarations.map((declaration) => ({ source, ...declaration })),
        version === undefined ? {} : { [source]: version }
      );

    /** Seed the boot declarations and run the sync — one boot of `Db.init`'s loader leg. */
    const boot = async (declarations: { table: Table<any>; record: any }[]) =>
      await bootAsSource(DEFAULT_TEST_SOURCE, declarations);

    const machineDeclaration = (record: Partial<SyncMachineAccount> & { id: string; email: string }) => ({
      table: machineTable,
      record: { status: 'active', ...record },
    });

    const machineRows = async (query: Partial<SyncMachineAccount> = {}) =>
      await getDbAsSystem().query(machineTable, query);

    /** The full loop's files live here for the run. */
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'source-records-'));
    const fileCache = () => namedObjectCache()['@proteinjs/db/SourceRecordDeclarationFile'];
    /** One boot of a build carrying ONE declaration file (from `pkg-f`) beside no code declarations. */
    const bootFile = async (filePath: string, table: Table<any>) => {
      namedObjectCache()['@proteinjs/db/SourceRecordDeclarationFile'] = [
        {
          qualifiedName: '@test/pkg-f/declarationFile',
          packageName: '@test/pkg-f',
          object: { table, path: filePath },
        },
      ];
      try {
        return await bootBuild([], { '@test/pkg-f': '1.0.0' });
      } finally {
        delete namedObjectCache()['@proteinjs/db/SourceRecordDeclarationFile'];
      }
    };
    const header = { environment: 'fixture', exportedAt: '2026-01-01T00:00:00.000Z' };
    /** The document at `<scratch>/<name>`, its sibling files beside it; the document's path. */
    const writeBundle = (name: string, bundle: SourceRecordDeclarationBundle) => {
      const filePath = path.join(scratch, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, SourceRecordDeclarationDocument.render(bundle.declaration));
      for (const relativePath of Object.keys(bundle.files)) {
        const sibling = path.join(path.dirname(filePath), relativePath);
        fs.mkdirSync(path.dirname(sibling), { recursive: true });
        fs.writeFileSync(sibling, bundle.files[relativePath]);
      }
      return filePath;
    };
    const writeDeclaration = async (name: string, records: Partial<SourceRecord>[], table: Table<any>) =>
      writeBundle(name, await SourceRecordDeclarationDocument.fromRecords(table, records, header));
    /** Every line the sync logs during one boot, beside its result. */
    const logging = async <T>(boot: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
      const lines: string[] = [];
      const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
        jest.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
          lines.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
        })
      );
      try {
        return { result: await boot(), lines };
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    };

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
      delete namedObjectCache()['@proteinjs/db/SourceRecordLoader'];
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
      await db.delete(sourceRecordSyncTestTables.InheritedStamp, {});
      await db.delete(sourceRecordSyncTestTables.SyncDerivedName, {});
      await db.delete(sourceRecordSyncTestTables.SyncWidget, {});
      await db.delete(sourceRecordSyncTestTables.SyncSoftRemovedWidget, {});
      await db.delete(sourceRecordSyncTestTables.SyncScopedEntry, {});
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

    test("a product edit of a declared field is the product's — never reverted while the declaration stands still; runtime-owned fields survive; converged boots write nothing", async () => {
      const declarations = [
        machineDeclaration({ id: 'machine-1', email: 'machine@test.local', displayName: 'Machine' }),
      ];
      await boot(declarations);

      // A runtime-owned write (the credential stand-in) never moves the row's authorship: the
      // declaration keeps landing on it.
      const db = getDbAsSystem();
      await db.update(machineTable, { id: 'machine-1', runtimeNote: 'provisioned' });
      await boot([machineDeclaration({ id: 'machine-1', email: 'machine@test.local', displayName: 'Machine v2' })]);
      const redefined = await db.get(machineTable, { id: 'machine-1' });
      expect(redefined).toMatchObject({ displayName: 'Machine v2', runtimeNote: 'provisioned' });

      // A product edit of a DECLARED field makes the row the product's: the unchanged declaration
      // never lands on it again (the precedence).
      await db.update(machineTable, { id: 'machine-1', displayName: 'Renamed by the product' });
      const kept = await boot([
        machineDeclaration({ id: 'machine-1', email: 'machine@test.local', displayName: 'Machine v2' }),
      ]);
      expect(kept[machineTable.name]).toMatchObject({ updates: 0, kept: 1, diverged: 0 });
      const afterEdit = await db.get(machineTable, { id: 'machine-1' });
      expect(afterEdit).toMatchObject({ displayName: 'Renamed by the product', runtimeNote: 'provisioned' });

      // A converged boot is a no-op: the row's `updated` stamp does not churn.
      const stampBefore = afterEdit.updated.valueOf();
      await boot([machineDeclaration({ id: 'machine-1', email: 'machine@test.local', displayName: 'Machine v2' })]);
      const afterIdleBoot = await db.get(machineTable, { id: 'machine-1' });
      expect(afterIdleBoot.updated.valueOf()).toBe(stampBefore);
    });

    test('a natural key held by a row the sync does not own refuses the declaration: the row untouched, the boot continues, the refusal counted and named', async () => {
      const db = getDbAsSystem();
      // A row written at runtime that happens to hold the declared natural key — a person's own
      // row (a signup under the address before the declaration shipped): their fields, their
      // credential (the runtime note stands in for the password hash), never source-owned.
      const persons = await db.insert(machineTable, {
        email: 'bridge@test.local',
        displayName: 'A person',
        runtimeNote: 'their-password-hash',
      });
      const bridge = machineDeclaration({ id: 'declared-id', email: 'bridge@test.local', displayName: 'Ops bridge' });
      const sibling = machineDeclaration({ id: 'sibling-id', email: 'sibling@test.local', displayName: 'Sibling' });

      const logged: string[] = [];
      const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
        jest.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
          logged.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
        })
      );
      const summary = await boot([bridge, sibling]).finally(() => consoleSpies.forEach((spy) => spy.mockRestore()));

      // The boot continued: the sibling declaration landed; the refused one is counted, not adopted.
      expect(summary[machineTable.name]).toMatchObject({ inserts: 1, adopted: 0, refused: 1 });
      expect(await db.get(machineTable, { id: 'sibling-id' })).toMatchObject({ isLoadedFromSource: true });
      // The person's row is exactly as it was: no declared field, no ownership stamp, no write.
      const after = await db.get(machineTable, { id: persons.id });
      expect(after).toMatchObject({
        email: 'bridge@test.local',
        displayName: 'A person',
        runtimeNote: 'their-password-hash',
      });
      expect(after.isLoadedFromSource).toBeFalsy();
      expect(after.sourcePackage).toBeFalsy();
      expect(after.status).toBeFalsy();
      expect(after.updated.valueOf()).toBe(persons.updated.valueOf());
      expect(RecordingMachineAccountWatcher.updates.filter((update) => update.id === persons.id)).toHaveLength(0);
      // Nothing was inserted under the declared id, and nothing is registered as a source record.
      expect(await db.get(machineTable, { id: 'declared-id' })).toBeUndefined();
      expect(new SourceRecordRepo().getSourceRecord(machineTable.name, persons.id)).toBeUndefined();
      expect(new SourceRecordRepo().getSourceRecord(machineTable.name, 'declared-id')).toBeUndefined();
      // One plain line names the declaration and the reason.
      const refusals = logged.filter((line) => line.includes('Refused declaration'));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain('SeededLoader0');
      expect(refusals[0]).toContain('bridge@test.local');
      expect(refusals[0]).toContain('does not own');

      // Idempotent: the next boot refuses again and still writes nothing to the row.
      const again = await boot([bridge, sibling]);
      expect(again[machineTable.name]).toMatchObject({ inserts: 0, refused: 1 });
      expect((await db.get(machineTable, { id: persons.id })).updated.valueOf()).toBe(persons.updated.valueOf());

      // Once the row is gone, the declaration lands as a fresh insert under its declared id.
      await db.delete(machineTable, { id: persons.id });
      const landed = await boot([bridge, sibling]);
      expect(landed[machineTable.name]).toMatchObject({ inserts: 1, refused: 0 });
      const fresh = await db.get(machineTable, { email: 'bridge@test.local' });
      expect(fresh).toMatchObject({ id: 'declared-id', displayName: 'Ops bridge', isLoadedFromSource: true });
      expect(fresh.runtimeNote).toBeFalsy();
    });

    test('a row the sync already owns keeps syncing by its natural key under an environment-random id — id and runtime fields kept, converged boots write nothing', async () => {
      const db = getDbAsSystem();
      // The shape of an account a deployed environment adopted in an earlier build: source-owned,
      // stamped by its package, holding the id the environment gave it (not the declared one),
      // with a provisioned credential and a declared field that has drifted.
      const owned = await db.insert(machineTable, {
        email: 'bridge@test.local',
        displayName: 'Drifted',
        runtimeNote: 'the-password-hash',
        status: 'active',
        isLoadedFromSource: true,
        sourcePackage: DEFAULT_TEST_SOURCE,
      });
      const bridge = machineDeclaration({
        id: 'declared-owned-id',
        email: 'bridge@test.local',
        displayName: 'Ops bridge',
      });

      const summary = await boot([bridge]);

      expect(summary[machineTable.name]).toMatchObject({ updates: 1, refused: 0, inserts: 0 });
      const rows = await machineRows({ email: 'bridge@test.local' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: owned.id,
        displayName: 'Ops bridge',
        runtimeNote: 'the-password-hash',
        isLoadedFromSource: true,
      });
      expect(await db.get(machineTable, { id: 'declared-owned-id' })).toBeUndefined();
      // Registered under the row's own id, not the declared one.
      expect(new SourceRecordRepo().getSourceRecord(machineTable.name, owned.id)).toBeDefined();
      expect(new SourceRecordRepo().getSourceRecord(machineTable.name, 'declared-owned-id')).toBeUndefined();

      // The id difference is not perpetual drift.
      const stampBefore = rows[0].updated.valueOf();
      await boot([bridge]);
      expect((await db.get(machineTable, { id: owned.id })).updated.valueOf()).toBe(stampBefore);
    });

    test('an owned row that lost its ownership marker outside the sync is refused like any unowned row — never re-stamped, the row and its runtime fields standing; the marker set back is the recovery', async () => {
      const db = getDbAsSystem();
      const bridge = machineDeclaration({
        id: 'declared-lost-id',
        email: 'bridge@test.local',
        displayName: 'Ops bridge',
      });
      // Boot 1: the declaration lands as a fresh insert — owned and stamped; a credential is minted at runtime.
      expect((await boot([bridge]))[machineTable.name]).toMatchObject({ inserts: 1, refused: 0 });
      const owned = await db.get(machineTable, { email: 'bridge@test.local' });
      expect(owned).toMatchObject({
        id: 'declared-lost-id',
        isLoadedFromSource: true,
        sourcePackage: DEFAULT_TEST_SOURCE,
      });
      await db.update(machineTable, { id: owned.id, runtimeNote: 'the-minted-hash' });

      // The marker is cleared outside the sync (a migration, a hand edit — the service door protects it).
      await db.update(machineTable, { id: owned.id, isLoadedFromSource: false });

      // Boot 2: the sync no longer owns the row, so the declaration is refused and the row is left as
      // it is — its declared fields, its credential and its status stand; nothing re-stamps it.
      const refusedBoot = await boot([bridge]);
      expect(refusedBoot[machineTable.name]).toMatchObject({ inserts: 0, updates: 0, adopted: 0, refused: 1 });
      const after = await db.get(machineTable, { id: owned.id });
      expect(after).toMatchObject({
        email: 'bridge@test.local',
        displayName: 'Ops bridge',
        status: 'active',
        runtimeNote: 'the-minted-hash',
        isLoadedFromSource: false,
      });
      expect(await db.get(machineTable, { id: 'declared-lost-id-other' })).toBeUndefined();

      // The recovery is the marker set back: the next boot owns the row again and writes nothing else.
      await db.update(machineTable, { id: owned.id, isLoadedFromSource: true });
      expect((await boot([bridge]))[machineTable.name]).toMatchObject({ inserts: 0, refused: 0, unchanged: 1 });
      expect(await db.get(machineTable, { id: owned.id })).toMatchObject({
        runtimeNote: 'the-minted-hash',
        isLoadedFromSource: true,
      });
    });

    test('an id-keyed declaration still claims a runtime row holding its own declared id — the id is minted by the declaration, never shared', async () => {
      const db = getDbAsSystem();
      // A row written before the table was source-loaded, under the id the declaration carries
      // (the insert type omits `id`; the loader's own inserts pass it the same way).
      await db.insert(defaultPolicyTable, {
        id: 'legacy-id',
        email: 'legacy@test.local',
        displayName: 'Old name',
      } as unknown as { email: string });

      const summary = await boot([
        { table: defaultPolicyTable, record: { id: 'legacy-id', email: 'legacy@test.local', displayName: 'Declared' } },
      ]);

      expect(summary[defaultPolicyTable.name]).toMatchObject({ adopted: 1, refused: 0 });
      expect(await db.get(defaultPolicyTable, { id: 'legacy-id' })).toMatchObject({
        displayName: 'Declared',
        isLoadedFromSource: true,
        sourcePackage: DEFAULT_TEST_SOURCE,
      });
    });

    test('onSourceRemoved update: removed rows are flagged through Db.update (watchers fire), never deleted; re-declaring reverts', async () => {
      const db = getDbAsSystem();
      const human = await db.insert(machineTable, { email: 'human@test.local', displayName: 'A human' });
      const keeper = machineDeclaration({ id: 'machine-keep', email: 'keeper@test.local' });
      await boot([machineDeclaration({ id: 'machine-1', email: 'machine@test.local' }), keeper]);

      // The source's next build drops machine-1 (while still declaring from this table —
      // ownership is per source, and a source only reconciles what it still speaks for).
      RecordingMachineAccountWatcher.updates = [];
      await boot([keeper]);

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
      await boot([keeper]);
      expect(RecordingMachineAccountWatcher.updates).toHaveLength(0);

      // Removal is reversible in source: re-declaring reverts the patch via drift reversion.
      await boot([machineDeclaration({ id: 'machine-1', email: 'machine@test.local' }), keeper]);
      expect((await db.get(machineTable, { id: 'machine-1' })).status).toBe('active');
    });

    test('the removal guard on an update-policy table counts only the rows this boot would patch — a row soft-removed by an earlier boot is not "removed" again, so removing one more never refuses, and a converged boot never refuses', async () => {
      const db = getDbAsSystem();
      const a = machineDeclaration({ id: 'machine-a', email: 'a@test.local' });
      const b = machineDeclaration({ id: 'machine-b', email: 'b@test.local' });
      const c = machineDeclaration({ id: 'machine-c', email: 'c@test.local' });
      await boot([a, b, c]);

      // Drop b: one row, never a wrong-file signal.
      expect((await boot([a, c]))[machineTable.name]).toMatchObject({ removedUpdates: 1 });
      expect((await db.get(machineTable, { id: 'machine-b' })).status).toBe('deactivated');

      // Later, drop c: ONE more row. The soft-removed b still carries is_loaded_from_source and
      // its stamp, so a guard that counted every candidate would see 2 of 3 and refuse — and
      // then refuse every boot after. The guard counts what this boot would actually patch.
      expect((await boot([a]))[machineTable.name]).toMatchObject({ removedUpdates: 1 });
      expect((await db.get(machineTable, { id: 'machine-c' })).status).toBe('deactivated');

      // Converged: both already patched, nothing to remove, nothing refused, nothing written.
      RecordingMachineAccountWatcher.updates = [];
      expect((await boot([a]))[machineTable.name]).toMatchObject({ removedUpdates: 0, deletes: 0 });
      expect(RecordingMachineAccountWatcher.updates).toHaveLength(0);
      expect((await db.get(machineTable, { id: 'machine-a' })).status).toBe('active');
    });

    test('soft removal + re-declaration under a renamed natural key: the kept row is adopted by its declared id — reactivated and re-derived, never collided into', async () => {
      const db = getDbAsSystem();
      const keeper = machineDeclaration({ id: 'machine-keep', email: 'keeper@test.local' });
      await boot([machineDeclaration({ id: 'machine-rn', email: 'rn-old@test.local', displayName: 'Ops' }), keeper]);
      // Runtime-owned state the adoption must preserve (the credential stand-in).
      await db.update(machineTable, { id: 'machine-rn', runtimeNote: 'provisioned' });

      // The declaration is removed: the update policy KEEPS the row (soft removal).
      await boot([keeper]);
      expect((await db.get(machineTable, { id: 'machine-rn' })).status).toBe('deactivated');

      // Re-declared under a NEW email: the natural-key match misses, but the soft-removed row
      // still holds the declared id. The sync must adopt that row in place — pre-fix this boot
      // crashed on a PK collision (insert of an id the kept row still occupies).
      RecordingMachineAccountWatcher.updates = [];
      const summary = await boot([
        machineDeclaration({ id: 'machine-rn', email: 'rn-new@test.local', displayName: 'Ops' }),
        keeper,
      ]);

      expect(summary[machineTable.name].adopted).toBe(1);
      expect(await db.get(machineTable, { email: 'rn-old@test.local' })).toBeUndefined();
      const adopted = await db.get(machineTable, { id: 'machine-rn' });
      // Reactivated and re-derived from the declaration; runtime-owned state preserved.
      expect(adopted).toMatchObject({
        email: 'rn-new@test.local',
        status: 'active',
        runtimeNote: 'provisioned',
        isLoadedFromSource: true,
      });
      // No duplicate row was minted: the account's history stays on the one row.
      expect(await machineRows()).toHaveLength(2);
      // The reactivation went through Db.update — watchers observed it.
      const reactivations = RecordingMachineAccountWatcher.updates.filter(
        (update) => update.id === 'machine-rn' && update.status === 'active'
      );
      expect(reactivations).toHaveLength(1);
      expect(reactivations[0]).toMatchObject({ email: 'rn-new@test.local' });

      // Adoption converges: the next boot writes nothing.
      const stampBefore = adopted.updated.valueOf();
      await boot([machineDeclaration({ id: 'machine-rn', email: 'rn-new@test.local', displayName: 'Ops' }), keeper]);
      expect((await db.get(machineTable, { id: 'machine-rn' })).updated.valueOf()).toBe(stampBefore);
    });

    test('a row the product edited on a declared column, re-declared under a renamed natural key: a two-sided divergence — warned, the row untouched under its old key, the declaration not loaded, never a collision on its id; the declaration coming to equal the row re-adopts it', async () => {
      const db = getDbAsSystem();
      const keeper = machineDeclaration({ id: 'machine-keep', email: 'keeper@test.local' });
      await boot([machineDeclaration({ id: 'machine-dv', email: 'dv-old@test.local', displayName: 'Ops' }), keeper]);
      // The product edits a DECLARED column: the row is the product's from here.
      await db.update(machineTable, { id: 'machine-dv', displayName: 'Renamed by the product' });
      const edited = await db.get(machineTable, { id: 'machine-dv' });

      // Re-declared under a NEW email: the natural-key match misses, and the row holding the
      // declared id is the product's — so it is not adopted. Pre-fix the sync then fell through
      // to the insert leg and the boot failed on the row's primary key.
      RecordingMachineAccountWatcher.updates = [];
      const summary = await boot([
        machineDeclaration({ id: 'machine-dv', email: 'dv-new@test.local', displayName: 'Ops' }),
        keeper,
      ]);
      // The removed-reconcile met the row under its old key and kept it; the stamp leg met the
      // declaration's claim by id and found the divergence. Nothing inserted, nothing patched.
      expect(summary[machineTable.name]).toMatchObject({
        diverged: 1,
        kept: 1,
        inserts: 0,
        adopted: 0,
        updates: 0,
        removedUpdates: 0,
      });
      const untouched = await db.get(machineTable, { id: 'machine-dv' });
      expect(untouched).toMatchObject({
        email: 'dv-old@test.local',
        displayName: 'Renamed by the product',
        status: 'active',
        isLoadedFromSource: true,
      });
      expect(untouched.updated.valueOf()).toBe(edited.updated.valueOf());
      expect(await db.get(machineTable, { email: 'dv-new@test.local' })).toBeUndefined();
      expect(await machineRows()).toHaveLength(2);
      expect(RecordingMachineAccountWatcher.updates).toHaveLength(0);

      // The declaration comes to equal the row, its key included: re-adopted — the stamp written,
      // nothing else.
      const readopted = await boot([
        machineDeclaration({ id: 'machine-dv', email: 'dv-old@test.local', displayName: 'Renamed by the product' }),
        keeper,
      ]);
      expect(readopted[machineTable.name]).toMatchObject({ adopted: 1, diverged: 0, kept: 0, inserts: 0 });
      expect(await db.get(machineTable, { id: 'machine-dv' })).toMatchObject({
        email: 'dv-old@test.local',
        displayName: 'Renamed by the product',
        status: 'active',
      });
    });

    test(`onSourceRemoved default: removed source rows are deleted; human rows survive`, async () => {
      const db = getDbAsSystem();
      const human = await db.insert(defaultPolicyTable, { email: 'human@test.local' });
      const keeper = { table: defaultPolicyTable, record: { id: 'default-keep', email: 'keeper@test.local' } };
      await boot([{ table: defaultPolicyTable, record: { id: 'default-1', email: 'temp@test.local' } }, keeper]);
      expect(await db.get(defaultPolicyTable, { id: 'default-1' })).toBeDefined();

      await boot([keeper]);
      expect(await db.get(defaultPolicyTable, { id: 'default-1' })).toBeUndefined();
      expect(await db.get(defaultPolicyTable, { id: 'default-keep' })).toBeDefined();
      expect(await db.get(defaultPolicyTable, { id: human.id })).toBeDefined();
    });

    test('the default lifecycle is rollback-idempotent: declare → remove (prune) → re-declare is a clean re-insert, never a collision', async () => {
      const db = getDbAsSystem();
      const keeper = { table: defaultPolicyTable, record: { id: 'default-keep', email: 'keeper@test.local' } };
      const declared = { table: defaultPolicyTable, record: { id: 'rb-1', email: 'rb1@test.local' } };
      await boot([declared, keeper]);
      expect(await db.get(defaultPolicyTable, { id: 'rb-1' })).toBeDefined();

      // Rollback: the declaration is removed — the default policy hard-deletes the row...
      await boot([keeper]);
      expect(await db.get(defaultPolicyTable, { id: 'rb-1' })).toBeUndefined();

      // ...so rolling forward again is a plain re-insert under the declared id — no PK
      // collision, no adoption needed. Tables that soft-remove (keep rows on removal) do not
      // get this for free: they must adopt the kept row instead (pinned above on the machine
      // table).
      const summary = await boot([declared, keeper]);
      expect(summary[defaultPolicyTable.name].inserts).toBe(1);
      expect(await db.get(defaultPolicyTable, { id: 'rb-1' })).toMatchObject({
        email: 'rb1@test.local',
        isLoadedFromSource: true,
        sourcePackage: DEFAULT_TEST_SOURCE,
      });
    });

    /**
     * Source-scoped pruning: multiple servers running DIFFERENT builds against ONE shared
     * database (the thought_type dev topology — two dev servers on one Spanner database).
     * Ownership grain is the declaring package: each declaration's source is the package that
     * compiled it into the build. The removed-reconcile must stay authoritative WITHIN a source
     * (a source still deletes declarations it itself removed) and be a strict no-op ACROSS
     * sources (a boot never deletes rows owned by a package absent from its build).
     */
    describe('source-scoped pruning (shared DB, per-package ownership)', () => {
      const decl = (id: string, email: string) => ({ table: defaultPolicyTable, record: { id, email } });

      test("one source's sync never deletes rows owned by a different source", async () => {
        const db = getDbAsSystem();

        // Build A (e.g. this checkout's flow types) declares {a-1, a-2}; build B (the other
        // checkout's media types) declares a disjoint set {b-1}.
        await bootAsSource('@test/pkg-a', [decl('a-1', 'a1@test.local'), decl('a-2', 'a2@test.local')]);
        await bootAsSource('@test/pkg-b', [decl('b-1', 'b1@test.local')]);

        // B's boot must NOT have pruned A's rows — this is the cross-server nuke.
        expect(await db.get(defaultPolicyTable, { id: 'a-1' })).toBeDefined();
        expect(await db.get(defaultPolicyTable, { id: 'a-2' })).toBeDefined();
        expect(await db.get(defaultPolicyTable, { id: 'b-1' })).toBeDefined();

        // Each row is stamped with its owning package — the scoping the prune runs on.
        expect((await db.get(defaultPolicyTable, { id: 'a-1' })).sourcePackage).toBe('@test/pkg-a');
        expect((await db.get(defaultPolicyTable, { id: 'b-1' })).sourcePackage).toBe('@test/pkg-b');

        // And symmetrically: A re-booting must not prune B's row.
        await bootAsSource('@test/pkg-a', [decl('a-1', 'a1@test.local'), decl('a-2', 'a2@test.local')]);
        expect(await db.get(defaultPolicyTable, { id: 'b-1' })).toBeDefined();
        expect(await db.get(defaultPolicyTable, { id: 'a-1' })).toBeDefined();
        expect(await db.get(defaultPolicyTable, { id: 'a-2' })).toBeDefined();
      });

      test('a source still prunes its OWN removed declarations without touching other sources', async () => {
        const db = getDbAsSystem();

        await bootAsSource('@test/pkg-a', [decl('a-1', 'a1@test.local'), decl('a-2', 'a2@test.local')]);
        await bootAsSource('@test/pkg-b', [decl('b-1', 'b1@test.local')]);

        // A's next build drops a-2: A's own removed declaration is pruned...
        await bootAsSource('@test/pkg-a', [decl('a-1', 'a1@test.local')]);
        expect(await db.get(defaultPolicyTable, { id: 'a-2' })).toBeUndefined();
        // ...while A's still-declared row and B's row both survive.
        expect(await db.get(defaultPolicyTable, { id: 'a-1' })).toBeDefined();
        expect(await db.get(defaultPolicyTable, { id: 'b-1' })).toBeDefined();
      });

      test('a build declaring nothing for a table prunes nothing', async () => {
        const db = getDbAsSystem();

        await bootAsSource('@test/pkg-a', [decl('a-1', 'a1@test.local')]);
        // A build whose declaring packages are all absent (or declare nothing for this table)
        // makes no claim about it — pre-fix this boot deleted EVERY source-loaded row.
        await bootAsSource('@test/pkg-b', []);
        expect(await db.get(defaultPolicyTable, { id: 'a-1' })).toBeDefined();
      });

      test("onSourceRemoved update is source-scoped too: a foreign boot does not flag another source's rows", async () => {
        const db = getDbAsSystem();

        await bootAsSource('@test/pkg-a', [
          { table: machineTable, record: { id: 'm-a', email: 'ma@test.local', status: 'active' } },
        ]);
        await bootAsSource('@test/pkg-b', [
          { table: machineTable, record: { id: 'm-b', email: 'mb@test.local', status: 'active' } },
        ]);

        // B's boot must not have treated A's machine account as removed.
        expect((await db.get(machineTable, { id: 'm-a' })).status).toBe('active');
        expect((await db.get(machineTable, { id: 'm-b' })).status).toBe('active');

        // A dropping its own declaration still deactivates it — and leaves B's untouched.
        await bootAsSource('@test/pkg-a', [
          { table: machineTable, record: { id: 'm-a2', email: 'ma2@test.local', status: 'active' } },
        ]);
        expect((await db.get(machineTable, { id: 'm-a' })).status).toBe('deactivated');
        expect((await db.get(machineTable, { id: 'm-b' })).status).toBe('active');
      });

      test('a declaration migrating to a new source is re-owned, not pruned by its old source', async () => {
        const db = getDbAsSystem();

        // k-1 starts life declared by pkg-a, then moves to pkg-b (package rename/move).
        await bootAsSource('@test/pkg-a', [decl('k-1', 'k1@test.local')]);
        await bootAsSource('@test/pkg-b', [decl('k-1', 'k1@test.local')]);
        // The later declaration re-owns the row in place (adoption keeps the id).
        expect((await db.get(defaultPolicyTable, { id: 'k-1' })).sourcePackage).toBe('@test/pkg-b');

        // pkg-a's next build no longer carries k-1 — but the row now belongs to pkg-b.
        await bootAsSource('@test/pkg-a', [decl('a-x', 'ax@test.local')]);
        expect(await db.get(defaultPolicyTable, { id: 'k-1' })).toBeDefined();
      });

      test('legacy rows (source_package NULL) are never pruned; still-declared ones are adopted and stamped', async () => {
        const db = getDbAsSystem();
        // Rows written before source_package existed: loaded from source, no ownership stamp.
        const legacyDeclared = await db.insert(defaultPolicyTable, {
          email: 'l1@test.local',
          isLoadedFromSource: true,
        });
        const legacyForeign = await db.insert(defaultPolicyTable, {
          email: 'l2@test.local',
          isLoadedFromSource: true,
        });

        await bootAsSource('@test/pkg-a', [decl(legacyDeclared.id, 'l1@test.local')]);

        // The declared legacy row converges: adopted by its declaring package and stamped.
        expect((await db.get(defaultPolicyTable, { id: legacyDeclared.id })).sourcePackage).toBe('@test/pkg-a');
        // The undeclared legacy row is out of prune scope — it may belong to a build that has
        // not rebooted onto the stamped world yet; its owner's next boot will claim it.
        expect(await db.get(defaultPolicyTable, { id: legacyForeign.id })).toBeDefined();
      });

      test('a declaration moving between packages WITHIN one build is re-owned in place — never deleted and re-inserted', async () => {
        const db = getDbAsSystem();

        // k-1 and a-other both start under pkg-a.
        await bootAsSource('@test/pkg-a', [decl('k-1', 'k1@test.local'), decl('a-other', 'aother@test.local')]);
        const before = await db.get(defaultPolicyTable, { id: 'k-1' });

        // The next build moves k-1 to pkg-b while pkg-a still declares a-other — ONE boot.
        // pkg-a's prune scope must not treat k-1 as removed (it is declared elsewhere in the
        // build): the row survives in place, then the stamp leg re-owns it.
        await bootBuild([
          { source: '@test/pkg-a', ...decl('a-other', 'aother@test.local') },
          { source: '@test/pkg-b', ...decl('k-1', 'k1@test.local') },
        ]);

        const after = await db.get(defaultPolicyTable, { id: 'k-1' });
        expect(after).toBeDefined();
        // Row continuity is the outcome: created unchanged means no delete+re-insert cycle
        // (a re-insert restamps created), so watchers saw no delete and references held.
        expect(after.created.valueOf()).toBe(before.created.valueOf());
        expect(after.sourcePackage).toBe('@test/pkg-b');
        expect(await db.get(defaultPolicyTable, { id: 'a-other' })).toBeDefined();
      });

      test('a within-build package move on an update-policy table never passes through the removed patch', async () => {
        const db = getDbAsSystem();

        await bootAsSource('@test/pkg-a', [
          { table: machineTable, record: { id: 'm-move', email: 'mmove@test.local', status: 'active' } },
          { table: machineTable, record: { id: 'm-stay', email: 'mstay@test.local', status: 'active' } },
        ]);
        // Runtime-owned state that must survive the move untouched (the credential stand-in).
        await db.update(machineTable, { id: 'm-move', runtimeNote: 'provisioned' });

        RecordingMachineAccountWatcher.updates = [];
        await bootBuild([
          {
            source: '@test/pkg-a',
            table: machineTable,
            record: { id: 'm-stay', email: 'mstay@test.local', status: 'active' },
          },
          {
            source: '@test/pkg-b',
            table: machineTable,
            record: { id: 'm-move', email: 'mmove@test.local', status: 'active' },
          },
        ]);

        const moved = await db.get(machineTable, { id: 'm-move' });
        expect(moved).toMatchObject({ status: 'active', runtimeNote: 'provisioned', sourcePackage: '@test/pkg-b' });
        // The row never transited 'deactivated': no watcher observed the removed patch.
        const deactivations = RecordingMachineAccountWatcher.updates.filter((u) => u.status === 'deactivated');
        expect(deactivations).toHaveLength(0);
      });

      test('cross-source boots leave a natural-key-synced row in place — its environment id preserved', async () => {
        const db = getDbAsSystem();
        // A row pkg-b owns under an environment-random id (adopted by an earlier build), synced
        // by natural key.
        const handMade = await db.insert(machineTable, {
          email: 'bridge2@test.local',
          runtimeNote: 'cred',
          isLoadedFromSource: true,
          sourcePackage: '@test/pkg-b',
        });
        await bootAsSource('@test/pkg-b', [
          { table: machineTable, record: { id: 'declared-bridge2', email: 'bridge2@test.local', status: 'active' } },
        ]);
        expect((await db.get(machineTable, { email: 'bridge2@test.local' })).id).toBe(handMade.id);

        // A DIFFERENT source booting (with its own machine declaration) must not prune, flag,
        // or disturb the adopted row — same id, same runtime state, still active.
        RecordingMachineAccountWatcher.updates = [];
        await bootAsSource('@test/pkg-a', [
          { table: machineTable, record: { id: 'm-a3', email: 'ma3@test.local', status: 'active' } },
        ]);
        const adopted = await db.get(machineTable, { email: 'bridge2@test.local' });
        expect(adopted).toMatchObject({ id: handMade.id, status: 'active', runtimeNote: 'cred' });
        const foreignTouches = RecordingMachineAccountWatcher.updates.filter((u) => u.id === handMade.id);
        expect(foreignTouches).toHaveLength(0);
      });

      test('legacy rows (source_package NULL) are excluded from the update-policy leg too', async () => {
        const db = getDbAsSystem();
        // A pre-source_package row on the update-policy table: loaded from source, unstamped.
        const legacy = await db.insert(machineTable, {
          email: 'legacy@test.local',
          status: 'active',
          isLoadedFromSource: true,
        });

        RecordingMachineAccountWatcher.updates = [];
        await bootAsSource('@test/pkg-a', [
          { table: machineTable, record: { id: 'm-a4', email: 'ma4@test.local', status: 'active' } },
        ]);

        // NULL-stamped rows are out of BOTH reconcile legs — not deleted (covered above) and
        // not flagged: the legacy machine account stays active, unobserved by watchers.
        expect((await db.get(machineTable, { id: legacy.id })).status).toBe('active');
        const legacyTouches = RecordingMachineAccountWatcher.updates.filter((u) => u.id === legacy.id);
        expect(legacyTouches).toHaveLength(0);
      });

      test('a package in the build that no longer declares anything for a table prunes its rows there — dropping the last declaration is a removal', async () => {
        const db = getDbAsSystem();

        // pkg-a declares a-1 on the default-policy table and m-1 on the machine table; pkg-b owns b-1.
        await bootBuild([
          { source: '@test/pkg-a', ...decl('a-1', 'a1@test.local') },
          {
            source: '@test/pkg-a',
            table: machineTable,
            record: { id: 'm-1', email: 'm1@test.local', status: 'active' },
          },
          { source: '@test/pkg-b', ...decl('b-1', 'b1@test.local') },
        ]);

        // pkg-a's next build keeps m-1 but drops its LAST default-policy declaration. The package is
        // still in the build, so it is authoritative for its own rows on every table: a-1 is removed.
        await bootBuild([
          {
            source: '@test/pkg-a',
            table: machineTable,
            record: { id: 'm-1', email: 'm1@test.local', status: 'active' },
          },
        ]);
        expect(await db.get(defaultPolicyTable, { id: 'a-1' })).toBeUndefined();
        // pkg-b's row on that table is untouched, and pkg-a's still-declared machine row survives.
        expect(await db.get(defaultPolicyTable, { id: 'b-1' })).toBeDefined();
        expect((await db.get(machineTable, { id: 'm-1' })).status).toBe('active');
      });

      test('unowned legacy rows no declaration in the build claims are counted, never pruned', async () => {
        const db = getDbAsSystem();
        const unowned = await db.insert(defaultPolicyTable, { email: 'u@test.local', isLoadedFromSource: true });

        // The build declares something else entirely: the legacy row is reported as unowned and left alone.
        const summary = await bootAsSource('@test/pkg-a', [decl('a-1', 'a1@test.local')]);
        expect(summary[defaultPolicyTable.name].unowned).toBe(1);
        expect(await db.get(defaultPolicyTable, { id: unowned.id })).toBeDefined();

        // Once a declaration claims it, it is owned (stamped) and no longer reported.
        const claimed = await bootAsSource('@test/pkg-a', [
          decl('a-1', 'a1@test.local'),
          decl(unowned.id, 'u@test.local'),
        ]);
        expect(claimed[defaultPolicyTable.name].unowned).toBe(0);
        expect((await db.get(defaultPolicyTable, { id: unowned.id })).sourcePackage).toBe('@test/pkg-a');
      });
    });

    /**
     * Version-scoped pruning WITHIN one package: two servers running different VERSIONS of the
     * same package against one shared database (a real incident — the main application at one
     * version of a shared package and a feature worktree at a later one, whose added declarations
     * the older build deleted on every boot). Every row carries the declaring package's version;
     * a boot never prunes (or flags) a row stamped by a NEWER version of the same package.
     * Within the same or an older stamped version, the package stays authoritative:
     * removals still land, and equal-version skew is last-writer-wins by design.
     */
    describe('version-scoped pruning (same package, different builds)', () => {
      const decl = (id: string, email: string) => ({ table: defaultPolicyTable, record: { id, email } });

      test('an older build of a package never prunes rows a newer build of the same package declared (the incident)', async () => {
        const db = getDbAsSystem();

        // The newer build (3.32.0) declares an added type k-2.
        await bootAsSource('@test/pkg-a', [decl('k-1', 'k1@test.local'), decl('k-2', 'k2@test.local')], '3.32.0');
        // The older build (3.29.0) boots without k-2 — pre-fix this deleted k-2 every boot.
        await bootAsSource('@test/pkg-a', [decl('k-1', 'k1@test.local')], '3.29.0');

        expect(await db.get(defaultPolicyTable, { id: 'k-2' })).toBeDefined();
        expect(await db.get(defaultPolicyTable, { id: 'k-1' })).toBeDefined();

        // The NEWER build remains authoritative for genuine removals: it drops k-2 for real.
        await bootAsSource('@test/pkg-a', [decl('k-1', 'k1@test.local')], '3.32.0');
        expect(await db.get(defaultPolicyTable, { id: 'k-2' })).toBeUndefined();
        expect(await db.get(defaultPolicyTable, { id: 'k-1' })).toBeDefined();
      });

      test('an older build never writes over a row a newer build of the same package stamped — content and stamp survive', async () => {
        const db = getDbAsSystem();
        const k1 = (displayName: string) => ({
          table: defaultPolicyTable,
          record: { id: 'k-1', email: 'k1@test.local', displayName },
        });

        // The newer build (3.32.0) declares k-1 with its current definition.
        await bootAsSource('@test/pkg-a', [k1('newer')], '3.32.0');
        // The older build (3.29.0) still declares k-1, with its older definition. Pre-fix this boot
        // rewrote the row (and downgraded its stamp) on every restart — content churn on a shared DB.
        const summary = await bootAsSource('@test/pkg-a', [k1('older')], '3.29.0');

        const row = await db.get(defaultPolicyTable, { id: 'k-1' });
        expect(row.displayName).toBe('newer');
        expect(row.sourcePackageVersion).toBe('3.32.0');
        expect(summary[defaultPolicyTable.name].skippedNewer).toBe(1);
        expect(summary[defaultPolicyTable.name].updates).toBe(0);

        // The newer build remains authoritative over its own rows: its next definition lands.
        await bootAsSource('@test/pkg-a', [k1('newest')], '3.32.0');
        expect((await db.get(defaultPolicyTable, { id: 'k-1' })).displayName).toBe('newest');
      });

      test('version skew on an update-policy table: an older build does not flag newer rows', async () => {
        const db = getDbAsSystem();

        await bootAsSource(
          '@test/pkg-a',
          [
            { table: machineTable, record: { id: 'mv-1', email: 'mv1@test.local', status: 'active' } },
            { table: machineTable, record: { id: 'mv-2', email: 'mv2@test.local', status: 'active' } },
          ],
          '2.0.0'
        );

        RecordingMachineAccountWatcher.updates = [];
        await bootAsSource(
          '@test/pkg-a',
          [{ table: machineTable, record: { id: 'mv-1', email: 'mv1@test.local', status: 'active' } }],
          '1.0.0'
        );

        // The newer build's machine account is not deactivated by the older build's boot.
        expect((await db.get(machineTable, { id: 'mv-2' })).status).toBe('active');
        const deactivations = RecordingMachineAccountWatcher.updates.filter((u) => u.status === 'deactivated');
        expect(deactivations).toHaveLength(0);
      });

      test('equal versions with differing sets remain last-writer-wins — the deliberate residual', async () => {
        const db = getDbAsSystem();

        // Two builds at the SAME version (uncommitted local skew) cannot be ordered; the
        // package stays authoritative within its own version: the later boot's set wins.
        await bootAsSource('@test/pkg-a', [decl('e-1', 'e1@test.local'), decl('e-2', 'e2@test.local')], '1.0.0');
        await bootAsSource('@test/pkg-a', [decl('e-1', 'e1@test.local')], '1.0.0');
        expect(await db.get(defaultPolicyTable, { id: 'e-2' })).toBeUndefined();
        expect(await db.get(defaultPolicyTable, { id: 'e-1' })).toBeDefined();
      });

      test('a build without a resolvable version never prunes version-stamped rows; unversioned stamps stay last-writer-wins', async () => {
        const db = getDbAsSystem();

        // Unversioned stamps carry no ordering: prunable by any build of the package —
        // versionless-to-versionless keeps the pre-version last-writer-wins behavior.
        await bootAsSource('@test/pkg-a', [decl('n-1', 'n1@test.local'), decl('n-2', 'n2@test.local')]);
        await bootAsSource('@test/pkg-a', [decl('n-1', 'n1@test.local')]);
        expect(await db.get(defaultPolicyTable, { id: 'n-2' })).toBeUndefined();

        // Versioned rows survive an unorderable (versionless) build's boot: it cannot place
        // itself before or after the stamp, so it must not delete what might be newer.
        await bootAsSource('@test/pkg-a', [decl('u-1', 'u1@test.local'), decl('u-2', 'u2@test.local')], '1.0.0');
        await bootAsSource('@test/pkg-a', [decl('u-1', 'u1@test.local')]);
        expect(await db.get(defaultPolicyTable, { id: 'u-2' })).toBeDefined();

        // A versioned build prunes older-or-equal stamps as usual (1.0.0 <= 1.0.1).
        await bootAsSource('@test/pkg-a', [decl('u-1', 'u1@test.local')], '1.0.1');
        expect(await db.get(defaultPolicyTable, { id: 'u-2' })).toBeUndefined();
        expect(await db.get(defaultPolicyTable, { id: 'u-1' })).toBeDefined();
      });

      test("the version resolver reads the declaring package's real package.json", async () => {
        const internals = new SourceRecordSyncRunner() as unknown as LoaderInternals;
        // A real dependency of this build resolves to its actual version (entry resolution +
        // walk-up works for exports-mapped packages, where `<pkg>/package.json` is not requireable).
        expect(internals.resolveSourceVersion('@proteinjs/db-query')).toMatch(/^\d+\.\d+\.\d+/);
        // Resolution failure degrades to versionless, never throws.
        expect(internals.resolveSourceVersion('@test/no-such-package')).toBeUndefined();
      });
    });

    describe('stamp hygiene: an unchanged declaration is never rewritten', () => {
      const versioned = (displayName: string) => ({
        table: defaultPolicyTable,
        record: { id: 'v-1', email: 'v1@test.local', displayName },
      });

      test('a version bump alone re-stamps nothing: the next release leaves unchanged rows (and their updated stamp) alone', async () => {
        const db = getDbAsSystem();
        await bootAsSource('@test/pkg-a', [versioned('same')], '1.23.0');
        const stamped = await db.get(defaultPolicyTable, { id: 'v-1' });
        expect(stamped.sourcePackageVersion).toBe('1.23.0');

        // The next release: the SAME declaration under a newer package version (every release
        // bumps the declaring package). Pre-fix this counted the version stamp as drift and
        // rewrote every row on every boot — `updated` churned on rows nobody changed.
        const summary = await bootAsSource('@test/pkg-a', [versioned('same')], '1.24.0');
        expect(summary[defaultPolicyTable.name]).toMatchObject({ updates: 0, unchanged: 1 });
        const idle = await db.get(defaultPolicyTable, { id: 'v-1' });
        expect(idle.updated.valueOf()).toBe(stamped.updated.valueOf());
        // The stamp records the version that last WROTE the row's definition.
        expect(idle.sourcePackageVersion).toBe('1.23.0');

        // A genuine redefinition still lands, and moves the stamp with it.
        const redefined = await bootAsSource('@test/pkg-a', [versioned('changed')], '1.24.0');
        expect(redefined[defaultPolicyTable.name].updates).toBe(1);
        const rewritten = await db.get(defaultPolicyTable, { id: 'v-1' });
        expect(rewritten).toMatchObject({ displayName: 'changed', sourcePackageVersion: '1.24.0' });
      });

      test('a row with no version stamp is stamped exactly once', async () => {
        const db = getDbAsSystem();
        // Written before versions existed (or by a build that could not resolve its version).
        await bootAsSource('@test/pkg-a', [versioned('same')]);
        expect((await db.get(defaultPolicyTable, { id: 'v-1' })).sourcePackageVersion).toBeFalsy();

        const first = await bootAsSource('@test/pkg-a', [versioned('same')], '2.0.0');
        expect(first[defaultPolicyTable.name].updates).toBe(1);
        expect((await db.get(defaultPolicyTable, { id: 'v-1' })).sourcePackageVersion).toBe('2.0.0');

        const second = await bootAsSource('@test/pkg-a', [versioned('same')], '2.0.0');
        expect(second[defaultPolicyTable.name]).toMatchObject({ updates: 0, unchanged: 1 });
      });

      test('fromDeclaration: derived fields land on insert, backfill existing rows exactly once, and never re-stamp', async () => {
        const db = getDbAsSystem();
        const derivedTable = sourceRecordSyncTestTables.SyncDerivedName;
        // bootBuild names each seeded loader `${source}/SeededLoader${i}` — the declaration's
        // own name is the part after the package, exactly what a migration's class name is.
        const declaration = { table: derivedTable, record: { id: 'd-1', email: 'd1@test.local' } };

        await boot([declaration]);
        expect(await db.get(derivedTable, { id: 'd-1' })).toMatchObject({ name: 'SeededLoader0' });

        // A row written before the derived field existed — before the sync's stamp, too (a
        // stamped row whose declared column moved would be the product's): backfilled ONCE by
        // the next boot…
        await db.update(derivedTable, { id: 'd-1', name: null, declarationStamp: null });
        const backfill = await boot([declaration]);
        expect(backfill[derivedTable.name].updates).toBe(1);
        const backfilled = await db.get(derivedTable, { id: 'd-1' });
        expect(backfilled.name).toBe('SeededLoader0');

        // …and never again: the derived value is part of the drift comparison like any field.
        const idle = await boot([declaration]);
        expect(idle[derivedTable.name]).toMatchObject({ updates: 0, unchanged: 1 });
        expect((await db.get(derivedTable, { id: 'd-1' })).updated.valueOf()).toBe(backfilled.updated.valueOf());

        // The derivation owns the field: a value typed into the record does not survive it.
        await boot([{ table: derivedTable, record: { id: 'd-1', email: 'd1@test.local', name: 'typed-by-hand' } }]);
        expect((await db.get(derivedTable, { id: 'd-1' })).name).toBe('SeededLoader0');
      });
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

    /**
     * THE FULL LOOP — authorship precedence (the sync's own stamp tells a declaration-authored
     * row from a product-authored one; the product's rows are never touched while the
     * declaration stands still, re-adopted when it equals them, and a two-sided divergence is
     * counted apart and warned), the outcome counted, idempotent loads, and the removal guard
     * against a wrong declaration. Generic fixtures: a "widgets" table keyed by sku.
     */
    describe('the full loop: authorship precedence on a widgets table', () => {
      const widgetTable = sourceRecordSyncTestTables.SyncWidget;
      const widget = (sku: string, name: string, extra: Partial<SyncWidget> = {}) => ({
        table: widgetTable,
        record: { id: `w-${sku}`, sku, name, price: 10, ...extra },
      });
      const widgetRows = async () => (await getDbAsSystem().query(widgetTable, {})) as SyncWidget[];
      const widgetRow = async (sku: string) => (await getDbAsSystem().get(widgetTable, { sku })) as SyncWidget;
      const loop = (summary: Awaited<ReturnType<typeof bootBuild>>) => summary[widgetTable.name];
      const bootWidgets = async (declarations: ReturnType<typeof widget>[], version = '1.0.0') =>
        await bootAsSource('@test/pkg-w', declarations, version);

      test("a product-created row keyed like a declaration is the product's: the declaration is refused — never rewritten, never inserted over", async () => {
        const db = getDbAsSystem();
        const theirs = await db.insert(widgetTable, { sku: 'A', name: 'Their A', price: 99, stockNote: 'theirs' });

        const summary = await bootWidgets([widget('A', 'Declared A')]);

        expect(loop(summary)).toMatchObject({ inserts: 0, updates: 0, adopted: 0, refused: 1, kept: 0 });
        const rows = await widgetRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: theirs.id, name: 'Their A', price: 99, stockNote: 'theirs' });
        expect(rows[0].isLoadedFromSource).toBeFalsy();
        expect(rows[0].declarationStamp).toBeFalsy();
      });

      test("a product EDIT of a declared column makes the row the product's — an unchanged declaration never lands on it; a runtime-owned edit does not flip authorship", async () => {
        const db = getDbAsSystem();
        await bootWidgets([widget('A', 'One'), widget('B', 'Two')]);
        // The sync's stamp rides every row it writes.
        expect((await widgetRow('A')).declarationStamp).toBeTruthy();

        await db.update(widgetTable, { name: 'Mine' }, { sku: 'A' }); // a declared column
        await db.update(widgetTable, { stockNote: 'counted' }, { sku: 'B' }); // runtime-owned

        const summary = await bootWidgets([widget('A', 'One'), widget('B', 'Two v2')]);

        expect(loop(summary)).toMatchObject({ updates: 1, kept: 1, diverged: 0, inserts: 0, deletes: 0 });
        expect(await widgetRow('A')).toMatchObject({ name: 'Mine' });
        expect(await widgetRow('B')).toMatchObject({ name: 'Two v2', stockNote: 'counted', isLoadedFromSource: true });
      });

      test('a TWO-SIDED divergence — the product edited the row and the declaration moved as well — is counted apart, warned once with both digests, and the row untouched, boot after boot; the declaration catching up re-adopts it', async () => {
        const db = getDbAsSystem();
        await bootWidgets([widget('A', 'One'), widget('B', 'Two')]);
        await db.update(widgetTable, { name: 'Mine' }, { sku: 'A' });
        const before = await widgetRow('A');

        const { result, lines } = await logging(() => bootWidgets([widget('A', 'One v2'), widget('B', 'Two')]));

        expect(loop(result)).toMatchObject({ diverged: 1, kept: 0, updates: 0, adopted: 0, unchanged: 1 });
        const after = await widgetRow('A');
        expect(after).toMatchObject({ name: 'Mine', declarationStamp: before.declarationStamp });
        expect(after.updated.valueOf()).toBe(before.updated.valueOf());
        // One warning names the key and both digests — the row's and the declaration's, apart.
        const warnings = lines.filter((line) => line.includes('Diverged on both sides'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("'sku' = 'A'");
        expect(warnings[0]).toContain('left untouched');
        const digests = /row digest ([0-9a-f]{64}), declaration digest ([0-9a-f]{64})/.exec(warnings[0]);
        expect(digests).not.toBeNull();
        expect((digests as RegExpExecArray)[1]).not.toBe((digests as RegExpExecArray)[2]);

        // Boot after boot: the same verdict, nothing written.
        expect(loop(await bootWidgets([widget('A', 'One v2'), widget('B', 'Two')]))).toMatchObject({
          diverged: 1,
          updates: 0,
        });
        expect((await widgetRow('A')).updated.valueOf()).toBe(before.updated.valueOf());

        // The declaration catches up with the product's edit: re-adopted — stamped, nothing else
        // written — and the declaration's next move lands.
        const caughtUp = await bootWidgets([widget('A', 'Mine'), widget('B', 'Two')]);
        expect(loop(caughtUp)).toMatchObject({ adopted: 1, diverged: 0, kept: 0, updates: 1 });
        const readopted = await widgetRow('A');
        expect(readopted).toMatchObject({ name: 'Mine', isLoadedFromSource: true });
        expect(readopted.declarationStamp).not.toBe(before.declarationStamp);
        expect(loop(await bootWidgets([widget('A', 'Theirs'), widget('B', 'Two')]))).toMatchObject({
          updates: 1,
          diverged: 0,
        });
        expect((await widgetRow('A')).name).toBe('Theirs');
      });

      test('absent from the declaration: a declaration-authored row is removed, a product-authored one is kept', async () => {
        const db = getDbAsSystem();
        await bootWidgets([widget('A', 'A'), widget('B', 'B'), widget('C', 'C')]);
        await db.update(widgetTable, { name: 'C, edited by the product' }, { sku: 'C' });

        const summary = await bootWidgets([widget('A', 'A')]);

        expect(loop(summary)).toMatchObject({ deletes: 1, kept: 1, unchanged: 1 });
        expect(await widgetRow('B')).toBeUndefined();
        expect(await widgetRow('C')).toMatchObject({ name: 'C, edited by the product' });
        expect(await widgetRow('A')).toBeDefined();
      });

      test("the upgrade: rows the sync wrote BEFORE stamps existed (loaded from source, a package, no stamp) are the declaration's — stamped once, never re-inserted; one that drifted before stamps is brought back to the declaration once; one no longer declared is removed; the second boot writes nothing", async () => {
        const db = getDbAsSystem();
        // The old loader's rows, as it left them on every consumer's database today.
        const legacy = (sku: string, name: string) => ({
          id: `w-${sku}`,
          sku,
          name,
          price: 10,
          isLoadedFromSource: true,
          sourcePackage: '@test/pkg-w',
          sourcePackageVersion: '1.0.0',
        });
        for (const row of [legacy('L1', 'L1'), legacy('L2', 'drifted before stamps'), legacy('L3', 'L3')]) {
          await db.insert(widgetTable, row);
        }
        for (const row of await widgetRows()) {
          expect(row.declarationStamp).toBeFalsy();
        }

        // The first boot with the stamp: L1 and L2 declared (L2's declaration says 'L2'), L3 dropped.
        const first = await bootWidgets([widget('L1', 'L1'), widget('L2', 'L2')]);
        expect(loop(first)).toMatchObject({ inserts: 0, updates: 2, adopted: 0, kept: 0, deletes: 1, unowned: 0 });
        expect(await widgetRows()).toHaveLength(2);
        expect(await widgetRow('L1')).toMatchObject({ id: 'w-L1', name: 'L1' });
        expect((await widgetRow('L1')).declarationStamp).toBeTruthy();
        expect(await widgetRow('L2')).toMatchObject({ id: 'w-L2', name: 'L2' });
        expect(await widgetRow('L3')).toBeUndefined();

        // The second boot: converged, nothing written.
        const second = await bootWidgets([widget('L1', 'L1'), widget('L2', 'L2')]);
        expect(loop(second)).toMatchObject({ inserts: 0, updates: 0, adopted: 0, kept: 0, deletes: 0, unchanged: 2 });

        // From here the precedence holds: a product edit on L1 is kept while the declaration stands still.
        await db.update(widgetTable, { name: 'Mine now' }, { sku: 'L1' });
        const third = await bootWidgets([widget('L1', 'L1'), widget('L2', 'L2')]);
        expect(loop(third)).toMatchObject({ kept: 1, updates: 0, unchanged: 1 });
        expect((await widgetRow('L1')).name).toBe('Mine now');
      });

      test('idempotent: a second load of the same declaration changes nothing — counts and stamps', async () => {
        await bootWidgets([widget('A', 'A'), widget('B', 'B')]);
        const before = await widgetRows();

        const summary = await bootWidgets([widget('A', 'A'), widget('B', 'B')]);

        expect(loop(summary)).toMatchObject({ inserts: 0, updates: 0, deletes: 0, adopted: 0, kept: 0, unchanged: 2 });
        const after = await widgetRows();
        for (const row of before) {
          const same = after.find((candidate) => candidate.id === row.id) as SyncWidget;
          expect(same.updated.valueOf()).toBe(row.updated.valueOf());
          expect(same.declarationStamp).toBe(row.declarationStamp);
        }
      });

      test('the removal guard: a declaration that would remove more than the named fraction refuses by name and touches nothing; one row is never a wrong-file signal', async () => {
        await bootWidgets([widget('A', 'A'), widget('B', 'B'), widget('C', 'C'), widget('D', 'D')]);

        // 3 of 4 — more than the default half — refused, with nothing removed.
        await expect(bootWidgets([widget('A', 'A')])).rejects.toThrow(/remove 3 of the 4 rows/);
        expect(await widgetRows()).toHaveLength(4);

        // Exactly half passes (the guard is "more than"), so does a single row of two.
        expect(loop(await bootWidgets([widget('A', 'A'), widget('B', 'B')])).deletes).toBe(2);
        expect(loop(await bootWidgets([widget('A', 'A')])).deletes).toBe(1);
        expect(await widgetRows()).toHaveLength(1);

        // The fraction is the table's to name: 1 disables the guard. (The sync reconciles the
        // reflection-registered table instance — the option is set on that one.)
        await bootWidgets([widget('A', 'A'), widget('B', 'B'), widget('C', 'C'), widget('D', 'D')]);
        const registered = getSourceRecordTables().find(
          (table) => table.name === widgetTable.name
        ) as Table<SyncWidget>;
        const options = registered.sourceRecordOptions;
        options.maxRemovedFraction = 1;
        try {
          expect(loop(await bootWidgets([widget('A', 'A')])).deletes).toBe(3);
        } finally {
          delete options.maxRemovedFraction;
        }
      });
    });

    /**
     * THE FULL LOOP — the declaration FILE as a source, the export door, and the grant behind it.
     */
    describe('the full loop: the declaration file and the export door on a widgets table', () => {
      const widgetTable = sourceRecordSyncTestTables.SyncWidget;
      const widget = (sku: string, name: string, extra: Partial<SyncWidget> = {}) => ({
        table: widgetTable,
        record: { id: `w-${sku}`, sku, name, price: 10, ...extra },
      });
      const widgetRows = async () => (await getDbAsSystem().query(widgetTable, {})) as SyncWidget[];
      const widgetRow = async (sku: string) => (await getDbAsSystem().get(widgetTable, { sku })) as SyncWidget;
      const widgetsFile = async (
        name: string,
        records: Partial<SyncWidget>[] | Partial<SyncSoftRemovedWidget>[],
        table: Table<any> = widgetTable
      ) => await writeDeclaration(name, records, table);

      afterEach(() => {
        delete objectCache()['@proteinjs/db/SourceRecordExportConfigFactory'];
        // No declaration file left seeded (reflection memoizes an empty answer for a code-only boot).
        expect(fileCache() ?? []).toEqual([]);
      });

      test("a declaration FILE is a declaration source: its rows load under the file's package, dates included; a second load is a no-op", async () => {
        const filePath = await widgetsFile('widgets.json', [
          { sku: 'F2', name: 'File two', price: 7, releasedAt: moment.utc('2026-03-04T00:00:00Z') },
          { sku: 'F1', name: 'File one', price: 5, releasedAt: null },
        ]);

        const first = await bootFile(filePath, widgetTable);
        expect(first[widgetTable.name]).toMatchObject({ inserts: 2, kept: 0 });
        const f2 = await widgetRow('F2');
        expect(f2).toMatchObject({
          name: 'File two',
          price: 7,
          sourcePackage: '@test/pkg-f',
          isLoadedFromSource: true,
        });
        expect(moment.utc(f2.releasedAt as moment.Moment).toISOString()).toBe('2026-03-04T00:00:00.000Z');
        expect((await widgetRow('F1')).releasedAt).toBeFalsy();

        const second = await bootFile(filePath, widgetTable);
        expect(second[widgetTable.name]).toMatchObject({ inserts: 0, updates: 0, deletes: 0, unchanged: 2 });

        // The file's rows are declaration-authored like any: a product edit is kept while the
        // file's row stands still, a row the file drops is removed (one row — never a wrong-file signal).
        await getDbAsSystem().update(widgetTable, { name: 'Renamed by the product' }, { sku: 'F1' });
        const third = await bootFile(
          await widgetsFile('widgets-2.json', [{ sku: 'F1', name: 'File one', price: 5 }]),
          widgetTable
        );
        expect(third[widgetTable.name]).toMatchObject({ deletes: 1, kept: 1, diverged: 0 });
        expect((await widgetRow('F1')).name).toBe('Renamed by the product');
        expect(await widgetRow('F2')).toBeUndefined();
      });

      test('a date-valued declared column CHANGED in the file lands — a corrected release day is drift like any other value, and the corrected row is a no-op on the next load', async () => {
        await bootFile(
          await widgetsFile('dated.json', [
            { sku: 'D1', name: 'Dated', price: 1, releasedAt: moment.utc('2026-03-04T00:00:00Z') },
          ]),
          widgetTable
        );
        expect(moment.utc((await widgetRow('D1')).releasedAt as moment.Moment).toISOString()).toBe(
          '2026-03-04T00:00:00.000Z'
        );

        const corrected = await widgetsFile('dated-2.json', [
          { sku: 'D1', name: 'Dated', price: 1, releasedAt: moment.utc('2026-03-05T00:00:00Z') },
        ]);
        const second = await bootFile(corrected, widgetTable);
        expect(second[widgetTable.name]).toMatchObject({ updates: 1, unchanged: 0, kept: 0 });
        expect(moment.utc((await widgetRow('D1')).releasedAt as moment.Moment).toISOString()).toBe(
          '2026-03-05T00:00:00.000Z'
        );

        const third = await bootFile(corrected, widgetTable);
        expect(third[widgetTable.name]).toMatchObject({ updates: 0, unchanged: 1 });
      });

      test("a product edit of a DATE-valued declared column is the product's like any other: kept, never adopted, never written over by the file's day", async () => {
        const filePath = await widgetsFile('dated-product.json', [
          { sku: 'P1', name: 'Dated', price: 1, releasedAt: moment.utc('2026-03-04T00:00:00Z') },
        ]);
        await bootFile(filePath, widgetTable);
        await getDbAsSystem().update(widgetTable, { releasedAt: moment.utc('2026-03-05T00:00:00Z') }, { sku: 'P1' });

        const second = await bootFile(filePath, widgetTable);

        expect(second[widgetTable.name]).toMatchObject({ kept: 1, adopted: 0, updates: 0, unchanged: 0 });
        expect(moment.utc((await widgetRow('P1')).releasedAt as moment.Moment).toISOString()).toBe(
          '2026-03-05T00:00:00.000Z'
        );
        // And a third boot says the same — the row stays the product's, boot after boot.
        expect((await bootFile(filePath, widgetTable))[widgetTable.name]).toMatchObject({
          kept: 1,
          adopted: 0,
          updates: 0,
        });
      });

      test('a declaration FILE on a table that soft-removes (an update policy): its rows insert — a file declares no id, so nothing is claimed by id; a row the file drops is patched, never deleted, once; listing it again reverts the patch on the same row', async () => {
        const softTable = sourceRecordSyncTestTables.SyncSoftRemovedWidget;
        const softRow = async (sku: string) => (await getDbAsSystem().get(softTable, { sku })) as SyncSoftRemovedWidget;
        const both = await widgetsFile(
          'soft-widgets.json',
          [
            { sku: 'S1', name: 'Soft one', price: 1, retired: false },
            { sku: 'S2', name: 'Soft two', price: 2, retired: false },
          ],
          softTable
        );
        const onlyOne = await widgetsFile(
          'soft-widgets-2.json',
          [{ sku: 'S1', name: 'Soft one', price: 1, retired: false }],
          softTable
        );

        const first = await bootFile(both, softTable);
        expect(first[softTable.name]).toMatchObject({ inserts: 2, deletes: 0, removedUpdates: 0, kept: 0 });
        const inserted = await softRow('S2');
        expect(inserted).toMatchObject({ retired: false, isLoadedFromSource: true, sourcePackage: '@test/pkg-f' });

        const second = await bootFile(onlyOne, softTable);
        expect(second[softTable.name]).toMatchObject({ deletes: 0, removedUpdates: 1, unchanged: 1, inserts: 0 });
        const patched = await softRow('S2');
        expect(patched).toMatchObject({
          id: inserted.id,
          retired: true,
          name: 'Soft two',
          price: 2,
          isLoadedFromSource: true,
        });
        expect(patched.declarationStamp).not.toBe(inserted.declarationStamp);

        const third = await bootFile(onlyOne, softTable);
        expect(third[softTable.name]).toMatchObject({ deletes: 0, removedUpdates: 0, updates: 0, unchanged: 1 });

        const fourth = await bootFile(both, softTable);
        expect(fourth[softTable.name]).toMatchObject({
          inserts: 0,
          updates: 1,
          unchanged: 1,
          deletes: 0,
          removedUpdates: 0,
        });
        expect(await softRow('S2')).toMatchObject({ id: inserted.id, retired: false });
        expect(await getDbAsSystem().query(softTable, {})).toHaveLength(2);
      });

      test('a declaration file is refused by name — a column outside declarationColumns, another table, a missing key — and nothing loads', async () => {
        const secretFile = path.join(scratch, 'secret.json');
        const base = (
          await SourceRecordDeclarationDocument.fromRecords(widgetTable, [{ sku: 'S', name: 'S', price: 1 }], header)
        ).declaration;
        fs.writeFileSync(
          secretFile,
          SourceRecordDeclarationDocument.render({
            ...base,
            columns: [...base.columns, 'apiKey'],
            rows: [{ ...base.rows[0], apiKey: 'sk-never' }],
          })
        );
        await expect(bootFile(secretFile, widgetTable)).rejects.toThrow(/'apiKey', which is not a declaration column/);
        expect(await widgetRows()).toHaveLength(0);

        const otherTable = path.join(scratch, 'other.json');
        fs.writeFileSync(otherTable, SourceRecordDeclarationDocument.render({ ...base, table: 'db_test_sync_other' }));
        await expect(bootFile(otherTable, widgetTable)).rejects.toThrow(/is for table 'db_test_sync_other'/);

        const noKey = path.join(scratch, 'nokey.json');
        fs.writeFileSync(noKey, SourceRecordDeclarationDocument.render(base).replace('"sku": "S"', '"sku": ""'));
        await expect(bootFile(noKey, widgetTable)).rejects.toThrow(/has no 'sku'/);

        // A table declaring no declaration columns accepts no file at all.
        const machineFile = path.join(scratch, 'machine.json');
        fs.writeFileSync(
          machineFile,
          SourceRecordDeclarationDocument.render({
            ...base,
            table: machineTable.name,
            key: 'email',
            columns: ['email'],
            rows: [{ email: 'm@test.local' }],
          })
        );
        await expect(bootFile(machineFile, machineTable)).rejects.toThrow(/not a declaration column/);
        expect(await widgetRows()).toHaveLength(0);
      });

      test('the export door renders the declaration — the key and the declared columns only, never the secret, rows sorted by key, the environment named — and the round trip is byte-stable', async () => {
        const db = getDbAsSystem();
        await bootAsSource('@test/pkg-w', [
          widget('B', 'Bee', { apiKey: 'sk-secret-b', releasedAt: moment.utc('2026-02-03T04:05:06Z') }),
          widget('A', 'Ay', { stockNote: 'runtime-only' }),
        ]);
        // A product-authored row is exported like any other row.
        await db.insert(widgetTable, { sku: 'C', name: 'Theirs', price: 3, apiKey: 'sk-secret-c' });
        objectCache()['@proteinjs/db/SourceRecordExportConfigFactory'] = [
          { getConfig: () => ({ environment: 'fixture-env' }) },
        ];

        const { declaration, files } = await new SourceRecordExport().export(widgetTable.name);

        expect(files).toEqual({});
        expect(declaration).toMatchObject({
          format: 'source-records/1',
          table: widgetTable.name,
          key: 'sku',
          columns: ['name', 'price', 'releasedAt', 'sku'],
          environment: 'fixture-env',
          rowCount: 3,
        });
        expect(declaration.scope).toBeUndefined();
        expect(declaration.rows.map((row) => row.sku)).toEqual(['A', 'B', 'C']);
        for (const row of declaration.rows) {
          expect(Object.keys(row).sort()).toEqual(['name', 'price', 'releasedAt', 'sku']);
        }
        expect(declaration.rows[1].releasedAt).toBe('2026-02-03T04:05:06.000Z');
        const text = SourceRecordDeclarationDocument.render(declaration);
        expect(text).not.toContain('sk-secret');
        expect(text).not.toContain('runtime-only');
        expect(text.endsWith('\n')).toBe(true);
        // Byte-stable: parsing and rendering again is the same bytes; a second export renders the same body.
        expect(SourceRecordDeclarationDocument.render(SourceRecordDeclarationDocument.parse(text))).toBe(text);
        const again = await new SourceRecordExport().export(widgetTable.name);
        expect(SourceRecordDeclarationDocument.sameRows(declaration, again.declaration)).toBe(true);

        // THE LOOP: the exported declaration, loaded onto an empty table, exports again identically…
        await db.delete(widgetTable, {});
        const filePath = path.join(scratch, 'exported.json');
        fs.writeFileSync(filePath, text);
        const loaded = await bootFile(filePath, widgetTable);
        expect(loaded[widgetTable.name]).toMatchObject({ inserts: 3 });
        const reExported = await new SourceRecordExport().export(widgetTable.name);
        expect(SourceRecordDeclarationDocument.sameRows(declaration, reExported.declaration)).toBe(true);
        // …and loaded again onto its own rows, it is a no-op.
        const idle = await bootFile(filePath, widgetTable);
        expect(idle[widgetTable.name]).toMatchObject({ inserts: 0, updates: 0, unchanged: 3 });
      });

      test('a product edit of a RUNTIME column never moves authorship — the next file change lands on the declared columns and the runtime column survives', async () => {
        await bootFile(await widgetsFile('b1-v1.json', [{ sku: 'X', name: 'X1', price: 1 }]), widgetTable);
        await getDbAsSystem().update(widgetTable, { stockNote: 'runtime-owned' }, { sku: 'X' });
        const second = await bootFile(
          await widgetsFile('b1-v2.json', [{ sku: 'X', name: 'X2', price: 2 }]),
          widgetTable
        );
        expect(second[widgetTable.name]).toMatchObject({ updates: 1, kept: 0, adopted: 0 });
        expect(await widgetRow('X')).toMatchObject({ name: 'X2', price: 2, stockNote: 'runtime-owned' });
      });

      test('a product edit of a DECLARED column: an unchanged file keeps it; a file that moved as well diverges; the file saying what the product said re-adopts it, and the file after that lands', async () => {
        const v1 = await widgetsFile('b2-v1.json', [{ sku: 'Y', name: 'Y1', price: 1 }]);
        await bootFile(v1, widgetTable);
        await getDbAsSystem().update(widgetTable, { name: 'Mine' }, { sku: 'Y' });
        expect((await bootFile(v1, widgetTable))[widgetTable.name]).toMatchObject({ kept: 1, diverged: 0, updates: 0 });
        const v2 = await bootFile(await widgetsFile('b2-v2.json', [{ sku: 'Y', name: 'Y2', price: 1 }]), widgetTable);
        expect(v2[widgetTable.name]).toMatchObject({ kept: 0, diverged: 1, updates: 0 });
        const v3 = await bootFile(await widgetsFile('b2-v3.json', [{ sku: 'Y', name: 'Y3', price: 3 }]), widgetTable);
        expect(v3[widgetTable.name]).toMatchObject({ kept: 0, diverged: 1, updates: 0 });
        expect(await widgetRow('Y')).toMatchObject({ name: 'Mine', price: 1 });
        // The loop closes: a pull that carries the product's edit makes the row the declaration's again.
        const v4 = await bootFile(await widgetsFile('b2-v4.json', [{ sku: 'Y', name: 'Mine', price: 1 }]), widgetTable);
        expect(v4[widgetTable.name]).toMatchObject({ adopted: 1, kept: 0, diverged: 0 });
        const v5 = await bootFile(
          await widgetsFile('b2-v5.json', [{ sku: 'Y', name: 'Theirs again', price: 1 }]),
          widgetTable
        );
        expect(v5[widgetTable.name]).toMatchObject({ updates: 1, kept: 0, diverged: 0 });
        expect((await widgetRow('Y')).name).toBe('Theirs again');
      });

      test('a file with a duplicate key is refused before anything loads', async () => {
        const filePath = await widgetsFile('b4.json', [
          { sku: 'D', name: 'one', price: 1 },
          { sku: 'D', name: 'two', price: 2 },
        ]);
        await expect(bootFile(filePath, widgetTable)).rejects.toThrow(
          /Two source record declarations share the natural key 'sku' = 'D'/
        );
        expect(await widgetRows()).toHaveLength(0);
      });

      test('a file keyed on another column than the table syncs on is refused by name', async () => {
        const filePath = path.join(scratch, 'b5a.json');
        const base = (
          await SourceRecordDeclarationDocument.fromRecords(widgetTable, [{ sku: 'K', name: 'K', price: 1 }], header)
        ).declaration;
        fs.writeFileSync(filePath, SourceRecordDeclarationDocument.render({ ...base, key: 'name' }));
        await expect(bootFile(filePath, widgetTable)).rejects.toThrow(/keys on 'name'; the table syncs on 'sku'/);
        expect(await widgetRows()).toHaveLength(0);
      });

      test('key VALUES renamed in the file — one rename is a remove + insert; renaming most of them trips the guard', async () => {
        await bootFile(
          await widgetsFile('b5b-v1.json', [
            { sku: 'A', name: 'A', price: 1 },
            { sku: 'B', name: 'B', price: 1 },
          ]),
          widgetTable
        );
        const one = await bootFile(
          await widgetsFile('b5b-v2.json', [
            { sku: 'A2', name: 'A', price: 1 },
            { sku: 'B', name: 'B', price: 1 },
          ]),
          widgetTable
        );
        expect(one[widgetTable.name]).toMatchObject({ deletes: 1, inserts: 1 });
        expect(await widgetRow('A')).toBeUndefined();
        expect(await widgetRow('A2')).toMatchObject({ name: 'A' });
        await bootFile(
          await widgetsFile('b5b-v3.json', [
            { sku: 'A2', name: 'A', price: 1 },
            { sku: 'B', name: 'B', price: 1 },
            { sku: 'C', name: 'C', price: 1 },
          ]),
          widgetTable
        );
        await expect(
          bootFile(
            await widgetsFile('b5b-v4.json', [
              { sku: 'A3', name: 'A', price: 1 },
              { sku: 'B3', name: 'B', price: 1 },
              { sku: 'C3', name: 'C', price: 1 },
            ]),
            widgetTable
          )
        ).rejects.toThrow(/remove 3 of the 3 rows/);
        expect(await widgetRows()).toHaveLength(3);
      });

      test('the export leaves out every column not declared — the secret, the runtime column, id, created, updated, the stamps', async () => {
        await bootFile(await widgetsFile('b7.json', [{ sku: 'E', name: 'E', price: 1 }]), widgetTable);
        await getDbAsSystem().update(widgetTable, { apiKey: 'sk-secret-never', stockNote: 'runtime' }, { sku: 'E' });
        objectCache()['@proteinjs/db/SourceRecordExportConfigFactory'] = [
          { getConfig: () => ({ environment: 'chk' }) },
        ];
        const exported = (await new SourceRecordExport().export(widgetTable.name)).declaration;
        const text = SourceRecordDeclarationDocument.render(exported);
        expect(exported.columns).toEqual(['name', 'price', 'releasedAt', 'sku']);
        for (const absent of [
          'sk-secret-never',
          'apiKey',
          'stockNote',
          'runtime',
          '"id"',
          'created',
          'updated',
          'declarationStamp',
          'isLoadedFromSource',
          'sourcePackage',
        ]) {
          expect(text).not.toContain(absent);
        }
      });

      test('the export door refuses a table with no declaration columns, a non-source table, and an environment that cannot name itself', async () => {
        objectCache()['@proteinjs/db/SourceRecordExportConfigFactory'] = [
          { getConfig: () => ({ environment: 'fixture-env' }) },
        ];
        await expect(new SourceRecordExport().export(machineTable.name)).rejects.toThrow(
          /declares no declaration columns/
        );
        await expect(new SourceRecordExport().export('db_test_dupe_preflight')).rejects.toThrow(
          /Not a source-record table/
        );
        delete objectCache()['@proteinjs/db/SourceRecordExportConfigFactory'];
        await expect(new SourceRecordExport().export(widgetTable.name)).rejects.toThrow(
          /register a SourceRecordExportConfigFactory/
        );
      });

      test("the export door is behind the consumer's grant: the library declares the permission slug; default-deny for everyone else", () => {
        const service = new SourceRecordExport();
        expect(service.serviceMetadata?.auth?.permission).toBe(SOURCE_RECORD_EXPORT_PERMISSION);
        expect(SOURCE_RECORD_EXPORT_PERMISSION).toBe('source-records-export');
        // No public door, no all-users door, no custom gate that could widen it.
        expect(service.serviceMetadata?.auth?.public).toBeFalsy();
        expect(service.serviceMetadata?.auth?.allUsers).toBeFalsy();
        expect(service.serviceMetadata?.auth?.canAccess).toBeUndefined();
      });
    });

    /**
     * THE FULL LOOP — a SCOPED key (two scopes may each hold one `welcome`), the row filter on
     * the export and the file, and an external column's sibling file, byte for byte.
     */
    describe('the full loop: a scoped key, the row filter and an external column on an entries table', () => {
      const entryTable = sourceRecordSyncTestTables.SyncScopedEntry;
      const entry = (scope: string, slug: string, title: string, body: string | null = null) => ({
        table: entryTable,
        record: { id: `e-${scope}-${slug}`, scope, slug, title, body },
      });
      const entryRows = async (query: Partial<SyncScopedEntry> = {}) =>
        (await getDbAsSystem().query(entryTable, query)) as SyncScopedEntry[];
      const entryRow = async (scope: string, slug: string) =>
        (await getDbAsSystem().get(entryTable, { scope, slug })) as SyncScopedEntry;
      const bootEntries = async (declarations: ReturnType<typeof entry>[]) =>
        await bootAsSource('@test/pkg-e', declarations, '1.0.0');
      const nameTheEnvironment = () => {
        objectCache()['@proteinjs/db/SourceRecordExportConfigFactory'] = [
          { getConfig: () => ({ environment: 'fixture-env' }) },
        ];
      };

      afterEach(() => {
        delete objectCache()['@proteinjs/db/SourceRecordExportConfigFactory'];
        // No declaration file left seeded (reflection memoizes an empty answer for a code-only boot).
        expect(fileCache() ?? []).toEqual([]);
      });

      test('the scoped key: two scopes, one name, two rows — matched, redefined, reconciled and refused by the pair', async () => {
        const db = getDbAsSystem();
        const house = entry('house', 'welcome', 'House welcome');
        const other = entry('other', 'welcome', 'Other welcome');

        const first = await bootEntries([house, other]);

        expect(first[entryTable.name]).toMatchObject({ inserts: 2, refused: 0 });
        expect(await entryRows({ slug: 'welcome' })).toHaveLength(2);
        expect(await entryRow('house', 'welcome')).toMatchObject({ title: 'House welcome', isLoadedFromSource: true });
        expect(await entryRow('other', 'welcome')).toMatchObject({ title: 'Other welcome', isLoadedFromSource: true });

        // A redefinition lands on ITS scope's row alone.
        const redefined = await bootEntries([entry('house', 'welcome', 'House welcome v2'), other]);
        expect(redefined[entryTable.name]).toMatchObject({ updates: 1, unchanged: 1 });
        expect((await entryRow('house', 'welcome')).title).toBe('House welcome v2');
        expect((await entryRow('other', 'welcome')).title).toBe('Other welcome');

        // The removed reconcile is by the pair: dropping the other scope's row leaves the house's.
        const dropped = await bootEntries([entry('house', 'welcome', 'House welcome v2')]);
        expect(dropped[entryTable.name]).toMatchObject({ deletes: 1, unchanged: 1 });
        expect(await entryRow('other', 'welcome')).toBeUndefined();
        expect(await entryRow('house', 'welcome')).toMatchObject({ title: 'House welcome v2' });

        // A product row in a third scope under the same name is refused by the pair, untouched.
        const theirs = await db.insert(entryTable, { scope: 'third', slug: 'welcome', title: 'Their welcome' });
        const refused = await bootEntries([
          entry('house', 'welcome', 'House welcome v2'),
          entry('third', 'welcome', 'Declared'),
        ]);
        expect(refused[entryTable.name]).toMatchObject({ refused: 1, unchanged: 1, inserts: 0 });
        expect(await entryRow('third', 'welcome')).toMatchObject({ id: theirs.id, title: 'Their welcome' });
        expect((await entryRow('third', 'welcome')).isLoadedFromSource).toBeFalsy();
      });

      test('a scoped key is validated by name: a declaration without its scope, two declarations sharing the pair, and a table whose unique index is not the pair', async () => {
        await expect(
          bootEntries([{ table: entryTable, record: { id: 'e-x', slug: 'x', title: 'X' } as any }])
        ).rejects.toThrow(/missing its natural key scope 'scope'/);
        await expect(bootEntries([entry('house', 'dup', 'One'), entry('house', 'dup', 'Two')])).rejects.toThrow(
          /share the natural key 'scope' = 'house', 'slug' = 'dup'/
        );
        expect(await entryRows()).toHaveLength(0);

        // Local (unregistered, never created) on purpose: validation fires before any db access.
        interface Misdeclared extends SourceRecord {
          scope: string;
          slug: string;
        }
        class MisdeclaredScopedKeyTable extends Table<Misdeclared> {
          name = 'db_test_sync_misdeclared_scoped_key';
          columns = withSourceRecordColumns<Misdeclared>({
            scope: new StringColumn('scope'),
            slug: new StringColumn('slug', { unique: { unique: true, indexName: 'misdeclared_slug' } }),
          });
          sourceRecordOptions = {
            naturalKey: 'slug',
            naturalKeyScope: 'scope',
          } as Table<Misdeclared>['sourceRecordOptions'];
        }
        await expect(
          boot([{ table: new MisdeclaredScopedKeyTable(), record: { id: 'm-1', scope: 'a', slug: 'b' } }])
        ).rejects.toThrow(/scoped by 'scope' requires a unique index over exactly \[scope, slug\]/);
      });

      test('the row filter: the export door renders only the rows within it, and a file carrying a row outside it is refused by name — nothing loads', async () => {
        const db = getDbAsSystem();
        await bootEntries([entry('house', 'welcome', 'Welcome'), entry('house', 'about', 'About')]);
        const theirs = await db.insert(entryTable, { scope: 'someone', slug: 'mine', title: 'Mine' });
        nameTheEnvironment();

        const { declaration } = await new SourceRecordExport().export(entryTable.name);

        expect(declaration).toMatchObject({ key: 'slug', scope: 'scope', rowCount: 2 });
        expect(declaration.rows.map((row) => [row.scope, row.slug])).toEqual([
          ['house', 'about'],
          ['house', 'welcome'],
        ]);
        expect(SourceRecordDeclarationDocument.render(declaration)).not.toContain('someone');

        // A row outside the filter smuggled into the file: refused by name, nothing loads, the
        // product's row untouched.
        const smuggled = writeBundle('smuggled.json', {
          declaration: {
            ...declaration,
            rows: [...declaration.rows, { body: null, scope: 'someone', slug: 'theirs', title: 'Theirs' }],
            rowCount: 3,
          },
          files: {},
        });
        await expect(bootFile(smuggled, entryTable)).rejects.toThrow(
          /row 2 is outside the table's declarationFilter: 'scope' is "someone", the filter says "house"/
        );
        expect(await entryRows()).toHaveLength(3);
        expect(await entryRow('someone', 'theirs')).toBeUndefined();
        expect(await entryRow('someone', 'mine')).toMatchObject({ id: theirs.id, title: 'Mine' });
      });

      test('an external column round-trips byte for byte: export → the sibling file beside the document → load → the same bytes on the row, and the re-export is the same bundle; the sibling edited on disk lands; a product edit of it is kept', async () => {
        const db = getDbAsSystem();
        const text = '# Welcome\n\nHello there.\n\n- no trailing newline normalization\n- tabs\tkept';
        await bootEntries([entry('house', 'welcome', 'Welcome', text), entry('house', 'about', 'About', null)]);
        nameTheEnvironment();

        const bundle = await new SourceRecordExport().export(entryTable.name);

        expect(bundle.declaration.externalColumns).toEqual(['body']);
        expect(bundle.files).toEqual({ 'house/welcome/body.md': text });
        expect(bundle.declaration.rows.map((row) => row.body)).toEqual([null, 'house/welcome/body.md']);
        expect(SourceRecordDeclarationDocument.render(bundle.declaration)).not.toContain('Hello there');

        // The document and its sibling on disk, loaded onto an empty table: the same bytes on the row.
        const documentPath = writeBundle('entries/entries.json', bundle);
        expect(fs.readFileSync(path.join(scratch, 'entries', 'house', 'welcome', 'body.md'), 'utf8')).toBe(text);
        await db.delete(entryTable, {});
        const loaded = await bootFile(documentPath, entryTable);
        expect(loaded[entryTable.name]).toMatchObject({ inserts: 2 });
        expect((await entryRow('house', 'welcome')).body).toBe(text);
        expect((await entryRow('house', 'about')).body).toBeNull();
        const again = await new SourceRecordExport().export(entryTable.name);
        expect(SourceRecordDeclarationDocument.sameBundle(again, bundle)).toBe(true);

        // The sibling edited on disk is the declaration moving: it lands.
        fs.writeFileSync(
          path.join(scratch, 'entries', 'house', 'welcome', 'body.md'),
          '# Welcome\n\nEdited on disk.\n'
        );
        const edited = await bootFile(documentPath, entryTable);
        expect(edited[entryTable.name]).toMatchObject({ updates: 1, unchanged: 1 });
        expect((await entryRow('house', 'welcome')).body).toBe('# Welcome\n\nEdited on disk.\n');

        // A product edit of the external column is the product's while the file stands still.
        await db.update(entryTable, { body: '# Mine\n' }, { scope: 'house', slug: 'welcome' });
        const kept = await bootFile(documentPath, entryTable);
        expect(kept[entryTable.name]).toMatchObject({ kept: 1, diverged: 0, updates: 0 });
        expect((await entryRow('house', 'welcome')).body).toBe('# Mine\n');
      });
    });

    test('a new source-record table inherits the ownership stamp columns from SourceRecord — never declared per table', async () => {
      // The fixture ({@link InheritedStampTable}) declares ONLY its own column. The ownership
      // stamps (source_package, source_package_version) must arrive from withSourceRecordColumns —
      // the single owner of the SourceRecord column set. If tables had to hand-declare the
      // stamps, any table whose author forgot them would silently lose the shared-DB prune
      // scoping this suite exists to guarantee.
      const table = sourceRecordSyncTestTables.InheritedStamp;

      // Type layer: the minted table carries the stamp columns, at their physical names,
      // without declaring them.
      expect(table.columns.sourcePackage?.name).toBe('source_package');
      expect(table.columns.sourcePackageVersion?.name).toBe('source_package_version');
      expect(isSourceRecordTable(table)).toBe(true);

      // Schema layer: the harness minted the physical table through TableManager, which derives
      // DDL from the type — so the stamp columns must have been emitted without the fixture
      // declaring them. One boot of the sync stamps a row through them; the write itself fails
      // if the physical columns were not emitted.
      await bootAsSource('@test/pkg-a', [{ table, record: { id: 's-1', email: 's1@test.local' } }], '1.0.0');
      const row = await getDbAsSystem().get(table, { id: 's-1' });
      expect(row).toMatchObject({
        sourcePackage: '@test/pkg-a',
        sourcePackageVersion: '1.0.0',
        isLoadedFromSource: true,
      });
    });
  };
};
