import { Database, SessionPool } from '@google-cloud/spanner';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';

/**
 * Session-pool sizing under the emulator (SPANNER_EMULATOR_HOST — the same switch the driver's
 * other emulator carve-outs key on): with no `sessionPoolOptions` in the config the driver's
 * Database handle carries an on-demand pool (`min: 0, incStep: 1`) instead of the vendor's
 * eager 25-session fill; an explicit `sessionPoolOptions` still wins; and without the emulator
 * host the pool is the vendor's default (min 25, incStep 25) — production's pool is untouched.
 *
 * The assertions read the pool the Database handle actually carries (`database.pool_`, the
 * vendor's own SessionPool and its merged `options`) — the handle's pool is what every op
 * borrows from, and `instance.database(name, poolOptions)` is the only place the options can
 * enter. Client construction only, no RPCs: the vendor's pool opens (and fills) in the
 * Database constructor, so its one network seam — `SessionPool._createSessions`, the
 * BatchCreateSessions call — is pinned to a no-op here; otherwise the no-emulator case would
 * fill 25 sessions against real Spanner with whatever ADC the machine holds.
 */

type DriverStatics = {
  SPANNER?: unknown;
  SPANNER_INSTANCE?: unknown;
  SPANNER_DB?: unknown;
  LIVENESS_MONITOR?: { stop(): void };
};

const statics = SpannerDriver as unknown as DriverStatics;

type DriverInternals = { getSpannerDb(): Database };

const poolOf = (db: Database): SessionPool => (db as unknown as { pool_: SessionPool }).pool_;

const dbOf = (config?: Partial<ConstructorParameters<typeof SpannerDriver>[0]>): Database =>
  (
    new SpannerDriver({
      projectId: 'fake',
      instanceName: 'fake',
      databaseName: 'fake',
      ...config,
    }) as unknown as DriverInternals
  ).getSpannerDb();

describe('Spanner session pool sizing under the emulator', () => {
  let savedEmulatorHost: string | undefined;

  beforeEach(() => {
    savedEmulatorHost = process.env.SPANNER_EMULATOR_HOST;
    // The network seam (see the file doc): no session is ever created against a backend here.
    jest
      .spyOn(SessionPool.prototype as unknown as { _createSessions(): Promise<void> }, '_createSessions')
      .mockResolvedValue();
  });

  afterEach(async () => {
    if (savedEmulatorHost === undefined) {
      delete process.env.SPANNER_EMULATOR_HOST;
    } else {
      process.env.SPANNER_EMULATOR_HOST = savedEmulatorHost;
    }
    // Close the handle so its pool's housekeeping timers end with the test, then drop the
    // process-wide statics so the next test constructs a fresh client.
    statics.LIVENESS_MONITOR?.stop();
    await (statics.SPANNER_DB as Database | undefined)?.close().catch(() => undefined);
    statics.SPANNER = undefined;
    statics.SPANNER_INSTANCE = undefined;
    statics.SPANNER_DB = undefined;
    statics.LIVENESS_MONITOR = undefined;
    jest.restoreAllMocks();
  });

  test('under SPANNER_EMULATOR_HOST with no sessionPoolOptions, the handle carries an on-demand pool: min 0, incStep 1, nothing filled', () => {
    process.env.SPANNER_EMULATOR_HOST = 'localhost:9010';

    const pool = poolOf(dbOf());

    expect(pool.options.min).toBe(0);
    expect(pool.options.incStep).toBe(1);
    // The outcome the sizing buys: a fresh handle creates no sessions until an op asks for one.
    expect(pool.size + pool.totalPending).toBe(0);
  });

  test('an explicit sessionPoolOptions in the config wins under the emulator (the existing contract, unchanged)', () => {
    process.env.SPANNER_EMULATOR_HOST = 'localhost:9010';

    const pool = poolOf(dbOf({ sessionPoolOptions: { min: 3, max: 7, incStep: 2 } }));

    expect(pool.options.min).toBe(3);
    expect(pool.options.max).toBe(7);
    expect(pool.options.incStep).toBe(2);
  });

  test("without the emulator host the pool is the vendor's default — min 25, incStep 25 (production untouched)", () => {
    delete process.env.SPANNER_EMULATOR_HOST;

    const pool = poolOf(dbOf());

    expect(pool.options.min).toBe(25);
    expect(pool.options.incStep).toBe(25);
  });
});
