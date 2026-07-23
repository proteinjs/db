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
      const [, operation] = await instance.createDatabase(config.databaseName);
      await operation.promise();
    } catch (error) {
      SpannerEmulatorProvisioner.swallowAlreadyExists(error);
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
