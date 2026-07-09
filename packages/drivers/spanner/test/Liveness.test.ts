import { EventEmitter } from 'events';
import { Database } from '@google-cloud/spanner';
import { SpannerDriver, SpannerLivenessMonitor } from '@proteinjs/db-driver-spanner';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

const waitFor = async (condition: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('Liveness', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('session-pool background error does not crash the process; liveness probe runs and succeeds', async () => {
    await spannerDriver.createDbIfNotExists();
    const db = (spannerDriver as unknown as { getSpannerDb(): Database }).getSpannerDb();
    const monitor = (SpannerDriver as unknown as { LIVENESS_MONITOR: SpannerLivenessMonitor }).LIVENESS_MONITOR;
    const exitSpy = jest.spyOn(monitor as any, 'exit').mockImplementation(() => {});
    const probeSpy = jest.spyOn(monitor as any, 'probe');

    // Exercise the real library-side path: SessionPool.emit('error') is forwarded to the
    // Database (database.js:156), which our monitor listens on. Before this fix, this emit
    // was an unhandled 'error' event and killed the process — this test completing at all
    // is the assertion that the crash is fixed.
    (db as unknown as { pool_: EventEmitter }).pool_.emit(
      'error',
      Object.assign(new Error('4 DEADLINE_EXCEEDED: fake'), { code: 4 })
    );

    await waitFor(() => probeSpy.mock.calls.length > 0);
    // the probe ran against the live emulator and must resolve
    await probeSpy.mock.results[0].value;

    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
