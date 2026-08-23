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
  isSourceRecordTable,
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
      const loader = new SourceRecordLoader();
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

      test('cross-source boots leave a natural-key-adopted row in place — adopted id preserved', async () => {
        const db = getDbAsSystem();
        // Hand-made row with an environment-random id, adopted by pkg-b via natural key.
        const handMade = await db.insert(machineTable, { email: 'bridge2@test.local', runtimeNote: 'cred' });
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
     * same package against one shared database (the actual brent-dev-2 incident — the main app
     * at thought-common 3.29.0 and a feature worktree at 3.32.0, whose added thought types the
     * older build deleted on every boot). Every row carries the declaring package's version;
     * a boot never prunes (or flags) a row stamped by a NEWER version of the same package.
     * Within the same or an older stamped version, the package stays authoritative:
     * removals still land, and equal-version skew is last-writer-wins by design.
     */
    describe('version-scoped pruning (same package, different builds)', () => {
      const decl = (id: string, email: string) => ({ table: defaultPolicyTable, record: { id, email } });

      test('an older build of a package never prunes rows a newer build of the same package declared (the incident)', async () => {
        const db = getDbAsSystem();

        // The newer build (e.g. thought-common 3.32.0) declares an added type k-2.
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
        const internals = new SourceRecordLoader() as unknown as LoaderInternals;
        // A real dependency of this build resolves to its actual version (entry resolution +
        // walk-up works for exports-mapped packages, where `<pkg>/package.json` is not requireable).
        expect(internals.resolveSourceVersion('@proteinjs/db-query')).toMatch(/^\d+\.\d+\.\d+/);
        // Resolution failure degrades to versionless, never throws.
        expect(internals.resolveSourceVersion('@test/no-such-package')).toBeUndefined();
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
