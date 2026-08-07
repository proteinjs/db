import { SpannerDriver } from '@proteinjs/db-driver-spanner';

/**
 * Op-level deadline + channel-death recycle (2026-08-06 overnight wedge: dead gRPC channel
 * after Mac sleep → every op hung forever, borrowed sessions never returned, heap OOM).
 * Pure unit tests: fake Database/Transaction/monitor injected into the driver's process-wide
 * statics via typed casts; no emulator involved.
 */

type DriverStatics = {
  SPANNER?: unknown;
  SPANNER_INSTANCE?: unknown;
  SPANNER_DB?: unknown;
  LIVENESS_MONITOR?: unknown;
  CLIENT_GENERATION: number;
  CONSECUTIVE_DEADLINE_FAILURES: number;
};

const statics = SpannerDriver as unknown as DriverStatics;

const fakeMonitor = {
  logPoolPressure: () => undefined,
  poolStats: () => ({ size: 0, available: 0, borrowed: 0, totalWaiters: 0 }),
  reportError: () => undefined,
  stop: () => undefined,
};

const hang = () => new Promise<never>(() => undefined);

const generateStatement = (() => ({ sql: 'UPDATE t SET x = 1', namedParams: { params: {} } })) as any;

const waitFor = async (condition: () => boolean, timeoutMs: number, label: string) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for: ${label}`);
};

const makeDriver = (config: { operationDeadlineMs: number; deadlineFailuresBeforeRecycle: number }, db: unknown) => {
  statics.SPANNER_DB = db;
  statics.LIVENESS_MONITOR = fakeMonitor;
  const driver = new SpannerDriver({
    projectId: 'fake',
    instanceName: 'fake',
    databaseName: 'fake',
    ...config,
  });
  // deadline/error logs are expected output of these tests — keep the run quiet
  jest.spyOn((driver as any).logger, 'error').mockImplementation(() => undefined);
  jest.spyOn((driver as any).logger, 'warn').mockImplementation(() => undefined);
  return driver;
};

describe('Spanner op deadlines', () => {
  beforeEach(() => {
    statics.CLIENT_GENERATION = 0;
    statics.CONSECUTIVE_DEADLINE_FAILURES = 0;
  });

  afterEach(() => {
    statics.SPANNER = undefined;
    statics.SPANNER_INSTANCE = undefined;
    statics.SPANNER_DB = undefined;
    statics.LIVENESS_MONITOR = undefined;
    statics.CONSECUTIVE_DEADLINE_FAILURES = 0;
    jest.restoreAllMocks();
  });

  test('a hanging query op fails at the deadline with an error naming it, carrying the same gRPC deadline', async () => {
    const run = jest.fn((_request: any) => hang());
    const driver = makeDriver({ operationDeadlineMs: 150, deadlineFailuresBeforeRecycle: 99 }, { run });

    await expect(driver.runQuery(generateStatement)).rejects.toThrow(/150ms deadline.*spanner query/);

    // The gRPC deadline on the request is the lever that cancels the RPC on a dead channel —
    // the library's stream error path is what returns the borrowed session to the pool.
    expect(run.mock.calls[0][0]).toMatchObject({ gaxOptions: { timeout: 150 } });
  }, 5000);

  test('a dml transaction hung on a dead channel (dml AND rollback hang) still RETURNS its session', async () => {
    // Fake Database.runTransactionAsync with the library's real session contract: the session
    // is released only when the run function settles. Every await inside the driver's run
    // function must therefore be deadline-bounded, or the session leaks forever.
    const released: string[] = [];
    const transaction = {
      runUpdate: jest.fn(() => hang()),
      rollback: jest.fn(() => hang()),
      commit: jest.fn(() => hang()),
    };
    const db = {
      runTransactionAsync: async (fn: (transaction: unknown) => Promise<unknown>) => {
        try {
          return await fn(transaction);
        } finally {
          released.push('session');
        }
      },
    };
    const driver = makeDriver({ operationDeadlineMs: 150, deadlineFailuresBeforeRecycle: 99 }, db);

    await expect(driver.runDml(generateStatement)).rejects.toThrow(/deadline/);

    // dml deadline (~150ms) → bounded rollback deadline (~150ms more) → run function settles
    // → the library's finally releases the session. A leak shows up as this wait timing out.
    await waitFor(() => released.length === 1, 2000, 'session returned to the pool');
    expect(transaction.rollback).toHaveBeenCalled();
  }, 5000);

  test('channel-death recycle: 3 consecutive deadline failures recycle the client once; success resets the count', async () => {
    let hangOps = true;
    const db = { run: jest.fn(() => (hangOps ? hang() : Promise.resolve([[]]))) };
    const driver = makeDriver({ operationDeadlineMs: 100, deadlineFailuresBeforeRecycle: 3 }, db);
    const recycleSpy = jest.spyOn(driver as any, 'recycleClient').mockImplementation(() => {
      statics.CLIENT_GENERATION += 1;
    });
    const failingOp = () => expect(driver.runQuery(generateStatement)).rejects.toThrow(/deadline/);

    await failingOp();
    await failingOp();
    expect(recycleSpy).not.toHaveBeenCalled();

    // Any success resets the consecutive count.
    hangOps = false;
    await driver.runQuery(generateStatement);
    expect(statics.CONSECUTIVE_DEADLINE_FAILURES).toBe(0);

    hangOps = true;
    await failingOp();
    await failingOp();
    expect(recycleSpy).not.toHaveBeenCalled(); // the reset really pushed the threshold out

    await failingOp();
    expect(recycleSpy).toHaveBeenCalledTimes(1); // 3rd consecutive failure → one recycle
    expect(statics.CONSECUTIVE_DEADLINE_FAILURES).toBe(0);
  }, 10000);

  test('deadline failures from a recycled (stale-generation) client never count against the fresh channel', async () => {
    const db = { run: jest.fn(() => hang()) };
    const driver = makeDriver({ operationDeadlineMs: 100, deadlineFailuresBeforeRecycle: 1 }, db);
    const recycleSpy = jest.spyOn(driver as any, 'recycleClient').mockImplementation(() => {
      statics.CLIENT_GENERATION += 1;
    });

    const pending = expect(driver.runQuery(generateStatement)).rejects.toThrow(/deadline/);
    // The client is recycled while the op is in flight — its failure belongs to the old channel.
    statics.CLIENT_GENERATION += 1;
    await pending;

    expect(recycleSpy).not.toHaveBeenCalled();
    expect(statics.CONSECUTIVE_DEADLINE_FAILURES).toBe(0);
  }, 5000);
});
