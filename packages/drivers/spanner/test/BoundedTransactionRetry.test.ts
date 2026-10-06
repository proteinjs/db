import { performance } from 'perf_hooks';
import {
  Db,
  Record,
  StringColumn,
  Table,
  tableByName,
  withRecordColumns,
  isTransactionRetryExhaustedError,
  TransactionRetryExhaustedError,
  TransactionRetryPolicy,
} from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SpannerDriver, SpannerOperationError } from '@proteinjs/db-driver-spanner';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { SourceRepository } from '@proteinjs/reflection';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * THE RETRY POLICY IS THE CALLER'S, PER WRITE. A write outside a transaction is a transaction of
 * its own; when the database aborts it (a lock conflict resolved against it — on the emulator,
 * any second read-write transaction while one is held), what happens next is what the write
 * named at the call:
 *
 * - Nothing named: the client library's runner re-runs it on its backoff ladder (2^n seconds plus
 *   jitter) inside the driver's hour-long budget — a DURABLE write lands once the conflict ends,
 *   however long that takes. Unchanged by this contract.
 * - A bounded policy (`retry: 'none'`, `retry: { attempts, maxMs }`): at most that many attempts
 *   (a short backoff of the driver's own between them), never past `maxMs`, after which the abort
 *   reaches the caller as the typed `TransactionRetryExhaustedError` carrying the attempts made,
 *   the elapsed wall-clock and the last abort — promptly, never re-run behind the caller's back.
 *   A BEST-EFFORT write names this: one the next write of its kind supersedes anyway, which must
 *   not stall its caller for the ladder's seconds (or minutes) against a conflict it will lose.
 *
 * The stall this contract removes is measured: before it, a one-attempt write under a held
 * competitor still waited the runner's first ladder step (two to three seconds) before anything
 * came back; after it, the typed refusal comes back in well under a second.
 *
 * Forcing an abort on the emulator, and its nondeterminism, exactly as RetriedAbortLogging.test.ts
 * does: a COMPETITOR read-write transaction is held open on a driver of its own (an uncommitted
 * write to the contested row), the victim writes the same row while it is held, and each scenario
 * runs against a fresh hold until the victim genuinely met an abort before it asserts.
 */

interface ProgressRow extends Record {
  name: string;
}

class ProgressTable extends Table<ProgressRow> {
  name = 'db_test_bounded_retry';
  columns = withRecordColumns<ProgressRow>({
    name: new StringColumn('name'),
  });
}

const table: Table<ProgressRow> = new ProgressTable();
const getTable = (tableName: string) => (tableName === table.name ? table : tableByName(tableName));
const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};
// The victim rides a driver of its own, spied; the competitor its own, so the victim's spies see
// only the victim's lines.
const spannerDriver = new SpannerDriver(spannerConfig, getTable);
const competitorDriver = new SpannerDriver(spannerConfig, getTable);

type DriverInternals = { logger: { error: (log: unknown) => void; debug: (log: unknown) => void } };
type LogLine = { message: string; error?: unknown; obj?: any };
const loggerOf = (driver: SpannerDriver) => (driver as unknown as DriverInternals).logger;

const settle = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(() => 'resolved' as const).catch((error: unknown) => error);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const abortLines = (spy: jest.SpyInstance): LogLine[] =>
  spy.mock.calls.map((call) => call[0] as LogLine).filter((log) => /^Transaction aborted at /.test(log.message));

/** The longest a competitor holds its transaction: a victim re-run behind its caller's back still lands and is measured. */
const MAX_HOLD_MS = 4_000;

describe('A write names its retry policy at the call; a bounded one surfaces the abort typed, promptly (emulator)', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const db = new Db(spannerDriver, getTable, new TransactionContext());
  const competitorDb = new Db(competitorDriver, getTable, new TransactionContext());
  let debugLogSpy: jest.SpyInstance;
  let errorLogSpy: jest.SpyInstance;

  const nameOf = async (id: string): Promise<string | undefined> => (await db.get(table, { id }))?.name;

  /**
   * A read-write transaction held open on the competitor: it rewrites the contested row and parks
   * until `release()`. `begun` resolves once its write is in place, so a victim started after it
   * meets the hold. Released at the latest after MAX_HOLD_MS, so a victim that is re-run behind
   * the caller's back (the stall this contract removes) still lands and the test can measure it
   * instead of hanging; the timer dies with the release, so nothing outlives the scenario.
   */
  const holdCompetitor = (id: string) => {
    let release!: () => void;
    let markBegun!: () => void;
    const held = new Promise<void>((resolve) => {
      const atTheLatest = setTimeout(resolve, MAX_HOLD_MS);
      release = () => {
        clearTimeout(atTheLatest);
        resolve();
      };
    });
    const begun = new Promise<void>((resolve) => (markBegun = resolve));
    const done = competitorDb.runTransaction(async () => {
      await competitorDb.update(table, { id, name: 'competitor' });
      markBegun();
      await held;
    });
    return { begun, release: () => release(), done };
  };

  /**
   * Run the victim against a freshly held competitor until the scenario's premise holds — the
   * emulator genuinely aborted the VICTIM, and kept doing so for as long as the scenario needs
   * (`premise` reads the victim's outcome and the abort lines on its logger) — retrying the whole
   * scenario on a fresh row otherwise: which of two contending transactions the emulator aborts
   * is not deterministic, and a scenario where it aborted the competitor instead proves nothing
   * about the victim's policy. `fire` is called once per scenario (a test's own counters reset
   * there). `release` says when the competitor lets go: when the victim has settled (the bounded
   * cases), or after a fixed hold (the durable case, whose victim is meant to re-run and land
   * once the hold ends).
   */
  const contendUntilAborted = async (opts: {
    fire: (id: string) => Promise<unknown>;
    release: 'whenTheVictimSettles' | { afterMs: number };
    premise: (outcome: unknown, aborts: LogLine[]) => boolean;
  }): Promise<{ id: string; outcome: unknown; elapsedMs: number; aborts: LogLine[] }> => {
    for (let scenario = 1; scenario <= 12; scenario += 1) {
      debugLogSpy?.mockRestore();
      errorLogSpy?.mockRestore();
      debugLogSpy = jest.spyOn(loggerOf(spannerDriver), 'debug').mockImplementation(() => undefined);
      errorLogSpy = jest.spyOn(loggerOf(spannerDriver), 'error').mockImplementation(() => undefined);
      const { id } = await db.insert(table, { name: 'original' });
      const competitor = holdCompetitor(id);
      await competitor.begun;
      const startedAt = performance.now();
      const victim = settle(opts.fire(id));
      if (opts.release !== 'whenTheVictimSettles') {
        await sleep(opts.release.afterMs);
        competitor.release();
      }
      const outcome = await victim;
      const elapsedMs = performance.now() - startedAt;
      competitor.release();
      await competitor.done.catch(() => undefined);
      const aborts = abortLines(debugLogSpy);
      if (opts.premise(outcome, aborts)) {
        return { id, outcome, elapsedMs, aborts };
      }
    }
    throw new Error('the emulator did not abort the victim as the scenario needs within the try budget');
  };

  /** The bounded cases' premise: every attempt the policy allowed was aborted — the refusal came back. */
  const refused = (outcome: unknown): boolean => isTransactionRetryExhaustedError(outcome);

  beforeAll(async () => {
    registerTestUser();
    (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ] = [table];
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await spannerDriver.createDbIfNotExists();
    await spannerDriver.getTableManager().loadTable(table);
  }, 60000);

  afterAll(async () => {
    await dropTable(table);
    await SpannerEmulatorProvisioner.release();
    delete (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ];
    clearTestUser();
  }, 60000);

  afterEach(() => {
    debugLogSpy?.mockRestore();
    errorLogSpy?.mockRestore();
  });

  test('a best-effort update (retry: none) under a held competitor comes back as the typed refusal in well under a second — one attempt, the abort as its cause — and never lands, not even later', async () => {
    const { id, outcome, elapsedMs, aborts } = await contendUntilAborted({
      fire: (rowId) => db.update(table, { id: rowId, name: 'best-effort' }, undefined, { retry: 'none' }),
      release: 'whenTheVictimSettles',
      // Level-agnostic on purpose: an abort was observed, whatever came back — so a build that
      // re-runs the write behind the caller's back (the stall) reaches the assertions and is
      // measured there, instead of being retried as a scenario that proved nothing.
      premise: (victim, aborts) => aborts.length > 0 || refused(victim),
    });

    // The stall this contract removes: the runner's first ladder step alone is two seconds.
    expect(elapsedMs).toBeLessThan(1_000);
    expect(isTransactionRetryExhaustedError(outcome)).toBe(true);
    const refusal = outcome as TransactionRetryExhaustedError;
    expect(refusal.attempts).toBe(1);
    expect(refusal.elapsedMs).toBeLessThan(1_000);
    expect(refusal.cause).toBeInstanceOf(SpannerOperationError);
    expect((refusal.cause as SpannerOperationError).code).toBe(10);
    expect(refusal.message).toContain('allowed 1 attempt');
    // The one abort was logged at debug under the policy's wording; nothing at error.
    expect(aborts.map((line) => line.message)).toEqual([
      'Transaction aborted at dml; its retry policy decides whether it runs again',
    ]);
    expect(aborts[0].obj.attempt).toBe(1);
    expect(errorLogSpy).not.toHaveBeenCalled();
    // The competitor's write is the row's truth, and stays so: nothing re-runs the refused write.
    expect(await nameOf(id)).toBe('competitor');
    await sleep(3_000);
    expect(await nameOf(id)).toBe('competitor');
  }, 120000);

  test('a bounded policy { attempts: 2, maxMs: 1500 } makes exactly two attempts, each aborted, then refuses typed — inside the budget, on the driver`s own short backoff', async () => {
    const policy: TransactionRetryPolicy = { attempts: 2, maxMs: 1_500 };
    const { outcome, elapsedMs, aborts } = await contendUntilAborted({
      fire: (rowId) => db.update(table, { id: rowId, name: 'best-effort' }, undefined, { retry: policy }),
      release: 'whenTheVictimSettles',
      premise: refused,
    });

    expect(isTransactionRetryExhaustedError(outcome)).toBe(true);
    const refusal = outcome as TransactionRetryExhaustedError;
    expect(refusal.attempts).toBe(2);
    expect(elapsedMs).toBeLessThan(1_500);
    expect(aborts.map((line) => line.obj.attempt)).toEqual([1, 2]);
    expect(refusal.message).toContain('allowed 2 attempts');
  }, 120000);

  test('maxMs bounds the attempts by the clock: an attempts count the budget cannot hold is cut short, and the refusal comes before the budget is spent', async () => {
    // Three attempts would need the driver's first two backoffs (100–199 ms, then 200–299 ms) to
    // fit inside 250 ms with the attempts themselves: they cannot, so the clock cuts the policy
    // short of its count.
    const { outcome, aborts } = await contendUntilAborted({
      fire: (rowId) =>
        db.update(table, { id: rowId, name: 'best-effort' }, undefined, { retry: { attempts: 3, maxMs: 250 } }),
      release: 'whenTheVictimSettles',
      premise: refused,
    });

    expect(isTransactionRetryExhaustedError(outcome)).toBe(true);
    const refusal = outcome as TransactionRetryExhaustedError;
    expect(refusal.elapsedMs).toBeLessThan(250);
    expect(refusal.attempts).toBeGreaterThanOrEqual(1);
    expect(refusal.attempts).toBeLessThan(3);
    expect(aborts).toHaveLength(refusal.attempts);
  }, 120000);

  test('a runTransaction body under a bounded policy is re-run that many times and no more; the refusal carries the count', async () => {
    let bodyRuns = 0;
    const { outcome, elapsedMs } = await contendUntilAborted({
      fire: (rowId) => {
        bodyRuns = 0;
        return db.runTransaction(
          async () => {
            bodyRuns += 1;
            await db.update(table, { id: rowId, name: 'best-effort' });
          },
          { retry: { attempts: 3 } }
        );
      },
      release: 'whenTheVictimSettles',
      premise: refused,
    });

    expect(isTransactionRetryExhaustedError(outcome)).toBe(true);
    expect((outcome as TransactionRetryExhaustedError).attempts).toBe(3);
    expect(bodyRuns).toBe(3);
    expect(elapsedMs).toBeLessThan(2_000);
  }, 120000);

  test('the default stays the library`s: a durable update (no policy) under a competitor released after half a second re-runs on the runner`s ladder and lands', async () => {
    const { id, outcome, elapsedMs, aborts } = await contendUntilAborted({
      fire: (rowId) => db.update(table, { id: rowId, name: 'durable' }),
      release: { afterMs: 500 },
      premise: (victim, aborts) => victim === 'resolved' && aborts.length > 0,
    });

    expect(outcome).toBe('resolved');
    // The runner's first ladder step is 2^1 s plus jitter: the durable write waited it out.
    expect(elapsedMs).toBeGreaterThanOrEqual(2_000);
    expect(aborts.map((line) => line.message)).toEqual([
      'Transaction aborted at dml; the transaction runner retries it',
    ]);
    expect(errorLogSpy).not.toHaveBeenCalled();
    expect(await nameOf(id)).toBe('durable');
  }, 120000);

  test('a policy that cannot be read is refused at the call, before any attempt', async () => {
    const { id } = await db.insert(table, { name: 'original' });
    await expect(db.update(table, { id, name: 'never' }, undefined, { retry: { attempts: 0 } })).rejects.toThrow(
      'attempts must be a whole number of at least 1'
    );
    await expect(
      db.update(table, { id, name: 'never' }, undefined, { retry: { attempts: 1, maxMs: 0 } })
    ).rejects.toThrow('maxMs must be a positive number');
    expect(await nameOf(id)).toBe('original');
  }, 60000);
});
