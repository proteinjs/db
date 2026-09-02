import { Database, SessionPool } from '@google-cloud/spanner';
import { DetachedDbOps } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';

/** grpc status codes that indicate connectivity trouble rather than an application error */
const CONNECTIVITY_GRPC_CODES = [4 /* DEADLINE_EXCEEDED */, 14 /* UNAVAILABLE */];

/**
 * Restart-requested exit code — the supervision contract shared with @proteinjs/build's
 * serve-package (ServePackageSupervisor.RESTART_REQUEST_EXIT_CODE): a supervised process
 * exiting with this code is respawned with bounded backoff instead of being treated as a plain
 * failure (which the supervisor mirrors, i.e. stays down). Orchestrators that restart on any
 * nonzero exit (systemd, Kubernetes) treat it like any other failure code, so it is safe
 * everywhere. Hard-coded by design: the contract crosses a process boundary, like a signal.
 */
const RESTART_REQUEST_EXIT_CODE = 86;

/** Session pool gauge (P4a): the four numbers that make pool exhaustion observable. */
export type SpannerSessionPoolStats = {
  size: number;
  available: number;
  borrowed: number;
  totalWaiters: number;
};

export class SpannerLivenessMonitor {
  private static readonly PROBE_SQL = 'SELECT 1';
  private static readonly PROBE_TIMEOUT_MS = 10_000;
  /** delay before each attempt; 5 attempts spanning ~2 min (fast failures) to ~4.5 min (30s-deadline failures) */
  private static readonly PROBE_DELAYS_MS = [0, 5_000, 15_000, 30_000, 60_000];
  /** waiters > 0 is the wedge signature — warn on sight, but at most once per interval per process */
  private static readonly POOL_PRESSURE_WARN_INTERVAL_MS = 10_000;
  private logger = new Logger({ name: this.constructor.name });
  private checkInFlight = false;
  private stopped = false;
  private lastPoolPressureWarnMs = Number.NEGATIVE_INFINITY;

  constructor(private db: Database) {}

  /** Attach the single 'error' listener; called once when the Database singleton is created. */
  start(): this {
    this.db.on('error', (error: any) => {
      if (this.stopped) {
        return;
      }
      this.logger.warn({
        message: `Spanner session pool emitted a background error; verifying db connectivity`,
        obj: { code: error?.code, errorDetails: error?.details ?? String(error), pool: this.poolStats() },
      });
      // Deliberately detached (the pool's error listener must return immediately) — routed
      // through the one detachment owner so a rejection can never become process death.
      DetachedDbOps.run('spanner liveness verification (pool error)', () => this.verifyLiveness(), {
        code: error?.code,
      });
    });
    return this;
  }

  /**
   * Retire this monitor when its client is recycled (channel-death recycle in SpannerDriver):
   * a stopped monitor must never escalate to process exit for a channel the driver has already
   * abandoned — the replacement client gets a fresh monitor.
   */
  stop(): void {
    this.stopped = true;
  }

  /** Called from driver catch blocks; probes only for connectivity-shaped errors. */
  reportError(error: any): void {
    if (this.stopped || !CONNECTIVITY_GRPC_CODES.includes(error?.code)) {
      return;
    }
    // Deliberately detached (the driver's catch block must not await the probe cycle) — routed
    // through the one detachment owner so a rejection can never become process death.
    DetachedDbOps.run('spanner liveness verification (driver-reported error)', () => this.verifyLiveness(), {
      code: error?.code,
    });
  }

  poolStats(): SpannerSessionPoolStats {
    const pool = (this.db as unknown as { pool_: SessionPool }).pool_;
    return { size: pool.size, available: pool.available, borrowed: pool.borrowed, totalWaiters: pool.totalWaiters };
  }

  /**
   * Warn whenever operations are queued waiting on the session pool (the silent-wedge
   * signature — with an infinite acquireTimeout a wedged pool otherwise produces no signal at
   * all). Called by the driver as ops are issued; throttled so a contended burst emits one
   * line per interval, not one per queued op.
   */
  logPoolPressure(nowMs = Date.now()): void {
    const stats = this.poolStats();
    if (stats.totalWaiters === 0) {
      return;
    }

    if (nowMs - this.lastPoolPressureWarnMs < SpannerLivenessMonitor.POOL_PRESSURE_WARN_INTERVAL_MS) {
      return;
    }

    this.lastPoolPressureWarnMs = nowMs;
    this.logger.warn({
      message: `Spanner session pool under pressure: operations are waiting for a session`,
      obj: stats,
    });
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
        if (this.stopped) {
          return; // client recycled mid-cycle — this channel's fate no longer matters
        }
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
      if (this.stopped) {
        return;
      }
      this.logger.error({
        message: `Db unreachable after sustained probing; exiting restart-requested (code ${RESTART_REQUEST_EXIT_CODE}) so supervision respawns into a valid state`,
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
    process.exit(RESTART_REQUEST_EXIT_CODE);
  }
}
