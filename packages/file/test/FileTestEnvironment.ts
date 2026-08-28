import { Db, Table, getDbAsSystem } from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { SpannerEmulatorProvisioner, getDropTestTable } from '@proteinjs/db-driver-spanner/test';
import { Session, type SessionData, type SessionDataStorage } from '@proteinjs/server-api';
import { SourceRepository } from '@proteinjs/reflection';
import { tables as userTables, User, UserRepo } from '@proteinjs/user';
import { tables as fileTables } from '../src/tables/tables';
import { FileStorage } from '../src/FileStorage';
import { FileStorageDriver } from '../src/FileStorageDriver';
import { FileStorageTableWatcher } from '../src/FileStorageTableWatcher';

/** In-memory SessionDataStorage seeded into the SourceRepository cache (tests don't load the
 *  generated source graph, so `Session` would otherwise find no implementation). */
class TestSessionDataStorage implements SessionDataStorage {
  environment = 'node' as const;
  private static data: SessionData;

  setData(data: SessionData) {
    TestSessionDataStorage.data = data;
  }

  getData(): SessionData {
    return TestSessionDataStorage.data;
  }
}

type SourceRepositoryInternals = { objectCache: Record<string, unknown[]> };
type FileStorageInternals = { driver?: FileStorageDriver };

/**
 * Emulator-backed test environment for db-file integration tests (Spanner emulator on
 * SPANNER_EMULATOR_HOST, provisioned on demand). Same shape as user-server's
 * UserServerTestEnvironment: seed deterministic session storage + db driver + file storage driver
 * into the SourceRepository cache, load the tables the suites touch, drop them on the way out.
 */
export class FileTestEnvironment {
  readonly spannerDriver = new SpannerDriver({
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  });
  private dropTestTable = getDropTestTable(this.spannerDriver);
  private userRepo = new UserRepo();

  async beforeAll() {
    // The emulator wipes its in-memory instances on any container restart (and CI service
    // containers start empty) — self-provision so suites never depend on out-of-band setup.
    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    const objectCache = this.objectCache();
    objectCache['@proteinjs/server-api/SessionDataStorage'] = [new TestSessionDataStorage()];
    objectCache['@proteinjs/db/DefaultDbDriverFactory'] = [{ getDbDriver: () => this.spannerDriver }];
    // Tests import src directly (no generated source graph), so the table registry that
    // cascade machinery resolves through (`tableByName`) must be seeded explicitly.
    objectCache['@proteinjs/db/Table'] = [...Object.values(userTables), ...Object.values(fileTables)] as unknown[];
    // The byte-deletion seam under test: prod loads it from the generated source graph.
    objectCache['@proteinjs/db/TableWatcher'] = [new FileStorageTableWatcher()];
    // The shared-content reachability seam getFile consults on a scoped-read miss (prod loads
    // implementations from the generated source graph; a graph-less harness lookup THROWS).
    // Default: no registered resolvers. Suites exercising the seam overwrite this entry.
    objectCache['@proteinjs/db-file/FileReachabilityResolver'] = [];
    Session.setData({
      sessionId: 'test-session',
      user: 'guest',
      data: {},
    });

    await this.loadTables(userTables);
    await this.loadTables(fileTables);
  }

  async afterAll() {
    await this.dropTables(fileTables);
    await this.dropTables(userTables);
    SpannerEmulatorProvisioner.release();
  }

  /**
   * Make `driver` the resolved FileStorageDriver: seeds the DefaultFileStorageDriverFactory the
   * driver resolution reads and clears the cached instance so the next resolution re-reads it.
   */
  setDriver(driver: FileStorageDriver) {
    this.objectCache()['@proteinjs/db-file/DefaultFileStorageDriverFactory'] = [{ getDriver: () => driver }];
    (FileStorage as unknown as FileStorageInternals).driver = undefined;
  }

  /** Insert a user row (as system) and return it. */
  async createUser(args: { name: string; email: string; roles?: string[] }): Promise<User> {
    return await getDbAsSystem().insert(userTables.User, {
      name: args.name,
      email: args.email,
      password: 'test',
      emailVerified: true,
      roles: args.roles ?? [],
    });
  }

  /** Seed the session cache with `user` — the identity service calls and scoped db ops run under. */
  actAs(user: User) {
    this.userRepo.setUser(user);
  }

  private objectCache(): Record<string, unknown[]> {
    return (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;
  }

  private async loadTables(tables: { [key: string]: Table<any> }) {
    const dbDriver = Db.getDefaultDbDriver();
    for (const table of Object.values(tables)) {
      await dbDriver.getTableManager().loadTable(table);
    }
  }

  private async dropTables(tables: { [key: string]: Table<any> }) {
    for (const table of Object.values(tables)) {
      await this.dropTestTable(table);
    }
  }
}
