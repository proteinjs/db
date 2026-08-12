import { Spanner } from '@google-cloud/spanner';

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
 * @internal This class is intended to be used only in tests. Do not use it in production code.
 */
export class SpannerEmulatorProvisioner {
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
      const [database, operation] = await instance.createDatabase(config.databaseName);
      await operation.promise();
      // createDatabase constructs a Database handle whose session pool OPENS in its constructor
      // (database.js: pool_.open()). Ignored, it becomes an orphan: its fill/keepalive machinery
      // outlives release(), and once the admin client closes, every subsequent pool op emits an
      // unlistened 'error' on this handle — crashing whichever jest suite happens to be active
      // (only fresh-emulator runs hit this; ALREADY_EXISTS constructs no handle). Own it through
      // its death: the listener covers session creates that settle after close, and the close
      // runs while the admin client can still delete the pool's sessions cleanly.
      database.on('error', () => undefined);
      await database.close().catch(() => undefined);
    } catch (error) {
      SpannerEmulatorProvisioner.swallowAlreadyExists(error);
    }
    await SpannerEmulatorProvisioner.pinVersionRetention(instance, config.databaseName);
  }

  /**
   * ALTER the emulator database's version_retention_period down to 1m (see class doc). Runs on
   * both the fresh-create and already-exists paths — a database that survived from a previous
   * run must end up pinned too. Idempotent; re-pinning an already-pinned database is a no-op
   * option write.
   */
  private static async pinVersionRetention(
    instance: ReturnType<Spanner['instance']>,
    databaseName: string
  ): Promise<void> {
    // A Database handle's session pool opens in its constructor (same hazard as the
    // createDatabase handle above) — own it through its death: error listener + close.
    const database = instance.database(databaseName);
    database.on('error', () => undefined);
    try {
      const [operation] = await database.updateSchema(
        `ALTER DATABASE \`${databaseName}\` SET OPTIONS (version_retention_period = '1m')`
      );
      await operation.promise();
    } finally {
      await database.close().catch(() => undefined);
    }
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
