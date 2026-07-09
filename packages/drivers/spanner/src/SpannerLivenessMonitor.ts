import { Database } from '@google-cloud/spanner';
import { Logger } from '@proteinjs/logger';

/** grpc status codes that indicate connectivity trouble rather than an application error */
const CONNECTIVITY_GRPC_CODES = [4 /* DEADLINE_EXCEEDED */, 14 /* UNAVAILABLE */];

export class SpannerLivenessMonitor {
  private static readonly PROBE_SQL = 'SELECT 1';
  private static readonly PROBE_TIMEOUT_MS = 10_000;
  /** delay before each attempt; 5 attempts spanning ~2 min (fast failures) to ~4.5 min (30s-deadline failures) */
  private static readonly PROBE_DELAYS_MS = [0, 5_000, 15_000, 30_000, 60_000];
  private logger = new Logger({ name: this.constructor.name });
  private checkInFlight = false;

  constructor(private db: Database) {}

  /** Attach the single 'error' listener; called once when the Database singleton is created. */
  start(): this {
    this.db.on('error', (error: any) => {
      this.logger.warn({
        message: `Spanner session pool emitted a background error; verifying db connectivity`,
        obj: { code: error?.code, errorDetails: error?.details ?? String(error) },
      });
      void this.verifyLiveness();
    });
    return this;
  }

  /** Called from driver catch blocks; probes only for connectivity-shaped errors. */
  reportError(error: any): void {
    if (!CONNECTIVITY_GRPC_CODES.includes(error?.code)) {
      return;
    }
    void this.verifyLiveness();
  }

  // --- helpers last ---

  private async verifyLiveness(): Promise<void> {
    if (this.checkInFlight) {
      return; // coalesce: eviction sweeps emit bursts of _destroy errors (the incident evicted several sessions)
    }
    this.checkInFlight = true;
    try {
      for (let attempt = 0; attempt < SpannerLivenessMonitor.PROBE_DELAYS_MS.length; attempt++) {
        await this.sleep(SpannerLivenessMonitor.PROBE_DELAYS_MS[attempt]);
        try {
          await this.probe();
          this.logger.info({ message: `Db connectivity verified`, obj: { attempt: attempt + 1 } });
          return;
        } catch (error: any) {
          this.logger.warn({
            message: `Db connectivity probe failed`,
            obj: { attempt: attempt + 1, errorDetails: error?.details ?? String(error) },
          });
        }
      }
      this.logger.error({
        message: `Db unreachable after sustained probing; exiting so supervision can restart into a valid state`,
      });
      this.exit();
    } finally {
      this.checkInFlight = false;
    }
  }

  private async probe(): Promise<void> {
    await this.db.run({
      sql: SpannerLivenessMonitor.PROBE_SQL,
      gaxOptions: { timeout: SpannerLivenessMonitor.PROBE_TIMEOUT_MS },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private exit(): void {
    process.exit(1);
  }
}
