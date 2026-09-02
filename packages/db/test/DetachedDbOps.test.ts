import { Logger } from '@proteinjs/logger';
import { DetachedDbOps } from '../src/DetachedDbOps';

/**
 * The detachment idiom's contract (the node-24 crash class): a deliberately fire-and-forget db
 * operation that REJECTS — e.g. a write that trips the driver's 60s op deadline — must be
 * terminally observed (logged with the caller's context), never left as an unhandled rejection
 * for node's default policy to kill the process over. These tests run with no emulator: the
 * simulated driver rejection IS the deadline failure's shape.
 *
 * Note: jest itself surfaces unhandled rejections as failures — so each green run here doubles
 * as the no-escape assertion (a dropped catch turns the log pins red AND leaks the rejection).
 */

const flushDetached = async () => {
  // The terminal catch attaches synchronously; the rejection lands on the microtask queue.
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

describe('DetachedDbOps', () => {
  let errorLogs: Array<{ message: string; obj?: Record<string, unknown>; error?: unknown }>;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorLogs = [];
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(function (log: any) {
      errorLogs.push(log);
    });
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('a rejecting detached operation is terminally observed — logged with the caller context, no escaping rejection', async () => {
    const deadlineRejection = new Error(
      '4 DEADLINE_EXCEEDED: spanner dml transaction (runTransactionAsync) exceeded the 60000ms op deadline'
    );
    DetachedDbOps.run('write flow-run heartbeat', () => Promise.reject(deadlineRejection), {
      flowRunId: 'run-1',
      table: 'flow_run',
    });
    await flushDetached();

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].message).toContain('Detached db operation failed');
    expect(errorLogs[0].message).toContain('write flow-run heartbeat');
    expect(errorLogs[0].obj).toEqual({ flowRunId: 'run-1', table: 'flow_run' });
    expect(errorLogs[0].error).toBe(deadlineRejection);
  });

  test('a synchronously-throwing work function is contained the same way — the caller never sees the throw', async () => {
    const boom = new Error('driver construction failed before any promise existed');
    expect(() =>
      DetachedDbOps.run(
        'sync-throwing detached op',
        () => {
          throw boom;
        },
        { site: 'test' }
      )
    ).not.toThrow();
    await flushDetached();

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].message).toContain('sync-throwing detached op');
    expect(errorLogs[0].error).toBe(boom);
  });

  test('a resolving detached operation logs nothing', async () => {
    let ran = false;
    DetachedDbOps.run('healthy detached op', async () => {
      ran = true;
      return 'ok';
    });
    await flushDetached();

    expect(ran).toBe(true);
    expect(errorLogs).toHaveLength(0);
  });

  test('context is optional — a rejection without context still logs the description', async () => {
    DetachedDbOps.run('context-free detached op', () => Promise.reject(new Error('deadline')));
    await flushDetached();

    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].message).toContain('context-free detached op');
  });
});
