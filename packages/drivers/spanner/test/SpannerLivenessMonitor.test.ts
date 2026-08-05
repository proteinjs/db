import { Database } from '@google-cloud/spanner';
import { SpannerLivenessMonitor } from '@proteinjs/db-driver-spanner';

type MonitorInternals = {
  probe(): Promise<void>;
  exit(): void;
  verifyLiveness(): Promise<void>;
  checkInFlight: boolean;
  logger: {
    info(args: { message: string; obj?: any }): void;
    warn(args: { message: string; obj?: any }): void;
    error(args: { message: string; obj?: any }): void;
  };
};

/** total of PROBE_DELAYS_MS [0, 5_000, 15_000, 30_000, 60_000] */
const ALL_PROBE_DELAYS_MS = 110_000;

describe('SpannerLivenessMonitor', () => {
  let monitor: SpannerLivenessMonitor;
  let internals: MonitorInternals;
  let probeSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  let errorLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    monitor = new SpannerLivenessMonitor({} as Database);
    internals = monitor as unknown as MonitorInternals;
    probeSpy = jest.spyOn(monitor as any, 'probe');
    exitSpy = jest.spyOn(monitor as any, 'exit').mockImplementation(() => {});
    jest.spyOn(internals.logger, 'info').mockImplementation(() => {});
    jest.spyOn(internals.logger, 'warn').mockImplementation(() => {});
    errorLogSpy = jest.spyOn(internals.logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('first probe succeeds: no exit, checkInFlight reset', async () => {
    probeSpy.mockResolvedValue(undefined);

    const check = internals.verifyLiveness();
    await jest.advanceTimersByTimeAsync(0);
    await check;

    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(internals.checkInFlight).toBe(false);
  });

  test('probe fails twice then succeeds: recovers, no exit', async () => {
    probeSpy
      .mockRejectedValueOnce(new Error('4 DEADLINE_EXCEEDED: fake'))
      .mockRejectedValueOnce(new Error('4 DEADLINE_EXCEEDED: fake'))
      .mockResolvedValue(undefined);

    const check = internals.verifyLiveness();
    await jest.advanceTimersByTimeAsync(ALL_PROBE_DELAYS_MS);
    await check;

    expect(probeSpy).toHaveBeenCalledTimes(3);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(internals.checkInFlight).toBe(false);
  });

  test('all 5 probes fail: exit called exactly once, fatal log emitted', async () => {
    probeSpy.mockRejectedValue(new Error('4 DEADLINE_EXCEEDED: fake'));

    const check = internals.verifyLiveness();
    await jest.advanceTimersByTimeAsync(ALL_PROBE_DELAYS_MS);
    await check;

    expect(probeSpy).toHaveBeenCalledTimes(5);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(errorLogSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Db unreachable after sustained probing') })
    );
  });

  test('the sustained-failure exit is RESTART-REQUESTED (code 86) so supervision respawns instead of staying down', async () => {
    // The serve-package contract (ServePackageSupervisor.RESTART_REQUEST_EXIT_CODE): 86 asks
    // the supervisor for a respawn with backoff; a plain exit(1) is mirrored and stays down —
    // observed as a dev server dead all night after a transient network outage.
    exitSpy.mockRestore();
    const processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    probeSpy.mockRejectedValue(new Error('14 UNAVAILABLE: fake'));

    const check = internals.verifyLiveness();
    await jest.advanceTimersByTimeAsync(ALL_PROBE_DELAYS_MS);
    await check;

    expect(processExitSpy).toHaveBeenCalledWith(86);
  });

  test('burst coalescing: reportError while a check is in flight triggers one probe cycle', async () => {
    probeSpy.mockResolvedValue(undefined);

    monitor.reportError(Object.assign(new Error('4 DEADLINE_EXCEEDED: fake'), { code: 4 }));
    monitor.reportError(Object.assign(new Error('14 UNAVAILABLE: fake'), { code: 14 }));
    await jest.advanceTimersByTimeAsync(0);

    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(internals.checkInFlight).toBe(false);
  });

  test('non-connectivity error code: no probe', async () => {
    probeSpy.mockResolvedValue(undefined);

    monitor.reportError(Object.assign(new Error('6 ALREADY_EXISTS: fake'), { code: 6 }));
    await jest.advanceTimersByTimeAsync(0);

    expect(probeSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('SpannerLivenessMonitor pool gauge (P4a)', () => {
  const fakePool = { size: 25, available: 20, borrowed: 5, totalWaiters: 0 };
  let monitor: SpannerLivenessMonitor;
  let warnLogSpy: jest.SpyInstance;

  beforeEach(() => {
    fakePool.size = 25;
    fakePool.available = 20;
    fakePool.borrowed = 5;
    fakePool.totalWaiters = 0;
    monitor = new SpannerLivenessMonitor({ pool_: fakePool } as unknown as Database);
    warnLogSpy = jest.spyOn((monitor as unknown as MonitorInternals).logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('poolStats surfaces the four pool numbers', () => {
    expect(monitor.poolStats()).toEqual({ size: 25, available: 20, borrowed: 5, totalWaiters: 0 });
  });

  test('no waiters: no pressure warning', () => {
    monitor.logPoolPressure(1_000);
    expect(warnLogSpy).not.toHaveBeenCalled();
  });

  test('waiters > 0: warns with the four pool numbers', () => {
    fakePool.available = 0;
    fakePool.borrowed = 25;
    fakePool.totalWaiters = 3;

    monitor.logPoolPressure(1_000);

    expect(warnLogSpy).toHaveBeenCalledTimes(1);
    expect(warnLogSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('session pool under pressure'),
        obj: { size: 25, available: 0, borrowed: 25, totalWaiters: 3 },
      })
    );
  });

  test('pressure warnings are throttled to one per interval', () => {
    fakePool.totalWaiters = 3;

    monitor.logPoolPressure(1_000);
    monitor.logPoolPressure(2_000); // within the 10s interval — suppressed
    expect(warnLogSpy).toHaveBeenCalledTimes(1);

    monitor.logPoolPressure(11_000); // interval elapsed — warns again
    expect(warnLogSpy).toHaveBeenCalledTimes(2);
  });
});
