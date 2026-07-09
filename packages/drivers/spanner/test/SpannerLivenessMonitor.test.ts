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
