import { Database, Spanner } from '@google-cloud/spanner';

/**
 * Shared test-harness provisioning for the Spanner emulator.
 *
 * The emulator holds instances IN MEMORY — any container restart (Docker updates, host reboots,
 * fresh CI service containers) silently wipes them, and every suite then fast-fails with a
 * cryptic gRPC "Instance not found" until someone re-provisions by hand. Harnesses call
 * `ensureProvisioned` in beforeAll; it is idempotent (ALREADY_EXISTS answers are success) and
 * gated on `SPANNER_EMULATOR_HOST`, so it can never touch real GCP.
 *
 * Provisioning uses the ADMIN API over gRPC on the SAME address the suites' data client uses —
 * no second endpoint to derive or configure, any docker port mapping works (the emulator's REST
 * port doesn't even need publishing), and it shares the data client's exact fate: if the address
 * is wrong, no suite could pass anyway.
 *
 * The database's `version_retention_period` is pinned to 1m (vs the 1h default): the emulator
 * keeps MVCC versions in RSS until they age out of retention, so under the provision-once
 * harness (schema and data live for a whole run and across runs) the 1h default turns every
 * delete/update into an hour of unreclaimable emulator memory. Measured: with 1m retention the
 * emulator's RSS plateaus instead of growing to OOM. Emulator-only by construction — the whole
 * path is gated on SPANNER_EMULATOR_HOST; cloud databases are never touched.
 *
 * INVARIANT — re-ensuring on an already-provisioned emulator issues ZERO DDL. `ensureProvisioned`
 * runs in every fresh process's first beforeAll (the once-per-run schema epoch lives on
 * `process`), and fresh processes appear MID-RUN: jest's `workerIdleMemoryLimit` restarts the
 * worker between suites, killing the old one with whatever background read-write transaction its
 * suites left in flight. The emulator rejects ANY schema change while a read-write transaction is
 * active (FAILED_PRECONDITION "a concurrent schema change operation or read-write transaction is
 * already in progress"), and a transaction stranded by a killed process stays active well past the
 * next suite's beforeAll — an unconditional pin ALTER here failed 11 of 101 flow-server suites in
 * exactly that pattern (CI run 31643570286). Reads are immune, so the pin reconciles: read the
 * current option, ALTER only on drift. The run's only legitimate DDL window stays the first
 * provisioning of a fresh emulator, where no predecessor process can have stranded anything.
 *
 * @internal This class is intended to be used only in tests. Do not use it in production code.
 */
export class SpannerEmulatorProvisioner {
  /** The retention the harness pins emulator databases to (see class doc). */
  private static readonly VERSION_RETENTION_PERIOD = '1m';

  /** Kept until release(): closing right after the create-operations races their trailing LRO
   *  callbacks into an unhandled "client has already been closed" that fails the suite. */
  private static client: Spanner | undefined;

  /** Ensure the instance + database exist on the emulator. No-op without SPANNER_EMULATOR_HOST. */
  static async ensureProvisioned(config: {
    projectId: string;
    instanceName: string;
    databaseName: string;
  }): Promise<void> {
    if (!process.env.SPANNER_EMULATOR_HOST) {
      return;
    }
    const spanner = SpannerEmulatorProvisioner.client ?? new Spanner({ projectId: config.projectId });
    SpannerEmulatorProvisioner.client = spanner;
    const instance = spanner.instance(config.instanceName);
    try {
      const [, operation] = await instance.create({
        config: 'emulator-config',
        displayName: `${config.instanceName} (test)`,
        nodes: 1,
      });
      await operation.promise();
    } catch (error) {
      SpannerEmulatorProvisioner.swallowAlreadyExists(error);
    }
    try {
      // createDatabase constructs a Database handle whose session pool OPENS in its constructor
      // (database.js: pool_.open()). Ignored, it becomes an orphan: its fill/keepalive machinery
      // outlives release(), and once the admin client closes, every subsequent pool op emits an
      // unlistened 'error' on this handle — crashing whichever jest suite happens to be active
      // (only fresh-emulator runs hit this; ALREADY_EXISTS constructs no handle). Own it through
      // its death: the listener covers session creates that settle after close. poolOptions
      // min 0 keeps the handle POOL-LESS (the SpannerDriver.createDb pattern) — with the default
      // pool, close() RACED the constructor's in-flight 25-session batch fill and the fill's
      // sessions landed after close's inventory sweep, orphaning 25 emulator sessions per
      // provisioning pass (measured 2026-09-02; the emulator never reaps them). The retention
      // pin rides THIS handle before the close: `Database.close()` evicts the instance's handle
      // cache under the BARE name key while options-keyed entries stay cached, so asking
      // `instance.database(name, sameOptions)` after the close returns the CLOSED handle
      // ("Database is closed." on the pin's read) — one handle, used then closed, sidesteps
      // the cache entirely.
      const [database, operation] = await instance.createDatabase(config.databaseName, {
        poolOptions: { min: 0 },
      });
      await operation.promise();
      database.on('error', () => undefined);
      try {
        await SpannerEmulatorProvisioner.pinVersionRetention(database, config.databaseName);
      } finally {
        await database.close().catch(() => undefined);
      }
      return;
    } catch (error) {
      SpannerEmulatorProvisioner.swallowAlreadyExists(error);
    }
    // ALREADY_EXISTS path (and any re-ensure): no handle from createDatabase — own a pool-less
    // one for the pin. Constructed DIRECTLY, never via instance.database(): that cache keys
    // entries by name+options but close() evicts only the bare-name key, so a previously closed
    // {min:0} handle (the create path's, in a re-ensure) would come back out of the cache dead
    // ("Database is closed." — the provisioner re-ensure test caught exactly this).
    const database = new Database(instance, config.databaseName, { min: 0 });
    database.on('error', () => undefined);
    try {
      await SpannerEmulatorProvisioner.pinVersionRetention(database, config.databaseName);
    } finally {
      await database.close().catch(() => undefined);
    }
  }

  /**
   * Reconcile the emulator database's version_retention_period to 1m (see class doc). Runs on
   * both the fresh-create and already-exists paths — a database that survived from a previous
   * run must end up pinned too. Read-before-write, NOT a blind re-pin: the ALTER is DDL, and
   * per the class invariant a re-ensure on an already-pinned database must issue zero DDL (a
   * stranded read-write transaction from a killed predecessor process fails ANY schema change
   * with FAILED_PRECONDITION; the read is immune). The current value comes from
   * INFORMATION_SCHEMA.DATABASE_OPTIONS — the admin API's `getMetadata()` does not surface the
   * option on the emulator (returns '' pinned or not; verified against emulator image 2026-08).
   */
  private static async pinVersionRetention(database: Database, databaseName: string): Promise<void> {
    // The handle is CALLER-OWNED (constructed pool-less and closed by ensureProvisioned) — see
    // the caller for the handle-cache and fill-race hazards that shaped that ownership.
    const [rows] = await database.run({
      sql: `SELECT s.OPTION_VALUE FROM INFORMATION_SCHEMA.DATABASE_OPTIONS s WHERE s.OPTION_NAME = 'version_retention_period'`,
      json: true,
    });
    const currentRetention = (rows[0] as { OPTION_VALUE?: string } | undefined)?.OPTION_VALUE;
    if (currentRetention === SpannerEmulatorProvisioner.VERSION_RETENTION_PERIOD) {
      return;
    }
    const [operation] = await database.updateSchema(
      `ALTER DATABASE \`${databaseName}\` SET OPTIONS (version_retention_period = '${SpannerEmulatorProvisioner.VERSION_RETENTION_PERIOD}')`
    );
    await operation.promise();
  }

  /** Close the admin client — call from afterAll so jest's event loop can drain. */
  static release(): void {
    try {
      SpannerEmulatorProvisioner.client?.close();
    } finally {
      SpannerEmulatorProvisioner.client = undefined;
    }
  }

  private static swallowAlreadyExists(error: unknown): void {
    if ((error as { code?: number }).code !== 6 /* gRPC ALREADY_EXISTS */) {
      throw error;
    }
  }
}
