import { randomBytes } from 'crypto';
import { inspect } from 'util';
import {
  Db,
  QueryBuilderFactory,
  Record,
  StatementFactory,
  StringColumn,
  Table,
  tableByName,
  withRecordColumns,
} from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SpannerDriver, SpannerOperationError } from '@proteinjs/db-driver-spanner';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { SourceRepository } from '@proteinjs/reflection';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * A transaction the client library's runner RETRIES is not failing while it is being retried.
 * Spanner resolves a lock conflict between read-write transactions by aborting one of them
 * (wound-wait), delivered as gRPC ABORTED (code 10) at the loser's next statement; the runner
 * re-runs the body on a fresh transaction and the next attempt succeeds. This is true of BOTH a
 * multi-statement `runTransaction` and a single-statement DML issued outside one (`runDml` with no
 * transaction — the driver runs it in its own implicit transaction under the same runner). Before
 * this contract the driver logged every rejected statement at error — one error line per aborted
 * attempt of a transaction that then succeeded, each an error report about nothing.
 *
 * The contract: an ABORTED raised by a statement inside a runner-driven transaction logs at debug
 * with its attempt number, never at error, and is never reported to the liveness monitor; only the
 * runner giving up — its retry budget spent — logs at error, once, with the last abort as its
 * cause. Every other failure (a unique violation inside the same transaction) logs at error
 * exactly as before. The retried-abort line is a line about a statement like any other: it
 * DESCRIBES the bound parameters (names, types, lengths) and never carries a value.
 *
 * Forcing an abort on the emulator ("only supports one transaction at a time"): a COMPETITOR
 * read-write transaction is held open (an uncommitted write), so a victim that writes while it is
 * held is aborted by the emulator. Which of two concurrent read-write transactions the emulator
 * aborts is not fully deterministic under load, so — exactly as this package's provisioner harness
 * does with its own emulator premise — each scenario is retried with a fresh key until the victim
 * genuinely met an abort; only then does it assert. A leftover row from a try that did not abort
 * carries an unrelated key and never touches an assertion (the table is dropped in afterAll).
 * Releasing the competitor the moment the victim's first abort is observed lets the victim's retry
 * win (the success cases); holding it through a 1ms retry budget spends the budget on the first
 * attempt (the exhaustion cases).
 */

interface AbortRow extends Record {
  name: string;
}

class AbortTestTable extends Table<AbortRow> {
  name = 'db_test_retried_abort';
  columns = withRecordColumns<AbortRow>({
    name: new StringColumn('name'),
  });
}

const table: Table<AbortRow> = new AbortTestTable();
const getTable = (tableName: string) => (tableName === table.name ? table : tableByName(tableName));
const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};
// The victim (the transaction under test) is spied on the driver that owns it. The competitor —
// the held-open writer that aborts the victim — rides its OWN driver instance (its own logger and
// its own default retry budget), so the victim's log spies see ONLY the victim, never the
// competitor's own activity, and the 1ms budget on `budgetDriver` never touches the competitor.
const spannerDriver = new SpannerDriver(spannerConfig, getTable);
const competitorDriver = new SpannerDriver(spannerConfig, getTable);
const budgetDriver = new SpannerDriver({ ...spannerConfig, transactionRetryTimeoutMs: 1 }, getTable);

type DriverInternals = { logger: { error: (log: unknown) => void; debug: (log: unknown) => void } };
type DriverStatics = { LIVENESS_MONITOR: { reportError: (error: unknown) => void } };
type LogLine = { message: string; error?: unknown; obj?: any };
const statics = SpannerDriver as unknown as DriverStatics;
const loggerOf = (driver: SpannerDriver) => (driver as unknown as DriverInternals).logger;

const settle = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(() => 'resolved' as const).catch((error: unknown) => error);

const insertRow = (id: string, name: string) => (config: any) =>
  new StatementFactory<AbortRow>().insert(
    table.name,
    { id, name, created: new Date(), updated: new Date() } as any,
    config
  );

const newId = () => randomBytes(16).toString('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const lines = (spy: jest.SpyInstance, message: string): LogLine[] =>
  spy.mock.calls.map((call) => call[0] as LogLine).filter((log) => log.message === message);

const failureLines = (spy: jest.SpyInstance): LogLine[] =>
  spy.mock.calls.map((call) => call[0] as LogLine).filter((log) => /^Failed when executing/.test(log.message));

const ABORT_DEBUG_LINE_DML = 'Transaction aborted at dml; the transaction runner retries it';

describe('Retried aborts log at debug; the exhausted retry budget logs at error (emulator)', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const db = new Db(spannerDriver, getTable, new TransactionContext());
  let errorLogSpy: jest.SpyInstance;
  let debugLogSpy: jest.SpyInstance;
  let reportErrorSpy: jest.SpyInstance;
  const spyOnVictim = (driver: SpannerDriver) => {
    errorLogSpy = jest.spyOn(loggerOf(driver), 'error').mockImplementation(() => undefined);
    debugLogSpy = jest.spyOn(loggerOf(driver), 'debug').mockImplementation(() => undefined);
  };

  const namesOf = async (ids: string[]): Promise<string[]> => {
    const qb = new QueryBuilderFactory().getQueryBuilder(table).condition({ field: 'id', operator: 'IN', value: ids });
    const rows = await db.query(table, qb);
    return rows.map((row) => row.name).sort();
  };

  /**
   * A read-write transaction held open on the competitor driver: it writes a row and then parks on
   * a promise, keeping the transaction active until `release()`. While it is held, any victim that
   * writes is aborted by the emulator's single-transaction serialization. `begun` resolves once the
   * competitor's write is in place (so a victim started after it is guaranteed to meet the hold).
   */
  const holdCompetitor = () => {
    let release!: () => void;
    let markBegun!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const begun = new Promise<void>((resolve) => (markBegun = resolve));
    const done = competitorDriver.runTransaction(async (transaction) => {
      await competitorDriver.runDml(insertRow(newId(), 'competitor'), transaction);
      markBegun();
      await held;
    });
    return { begun, release: () => release(), done };
  };

  /**
   * Run the victim against a freshly held competitor until the emulator genuinely aborts the
   * victim (the premise), retrying with a fresh key — the provisioner harness's approach to the
   * emulator's abort nondeterminism. `fire(mine)` issues the victim (a runTransaction or a plain
   * runDml) and settles to 'resolved' or the error. `release: 'onFirstAbort'` frees the competitor
   * the moment the victim's first abort is logged (so the retry can win); `release: 'never'` holds
   * it through the whole attempt (the 1ms-budget exhaustion cases). The victim's driver is re-spied
   * each try, so the returned/asserted spies reflect only the winning try. A leftover row from a
   * non-aborting try has an unrelated key.
   */
  // An abort of the victim was observed — at DEBUG (the fix) OR at ERROR (pre-fix / a reverted
  // classification). The premise loop keys on this level-agnostic signal so that reverting the
  // fix still establishes the premise and then reds a crisp per-level assertion, rather than
  // stalling the loop.
  const abortObserved = (): boolean =>
    lines(debugLogSpy, ABORT_DEBUG_LINE_DML).length >= 1 ||
    failureLines(errorLogSpy).some((line) => (line.obj?.cause as { code?: number } | undefined)?.code === 10);

  const contendUntilAborted = async (opts: {
    victim: SpannerDriver;
    fire: (mine: string) => Promise<unknown>;
    release: 'onFirstAbort' | 'never';
    premiseOutcome: (outcome: unknown) => boolean;
  }): Promise<{ mine: string; outcome: unknown; aborts: LogLine[] }> => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      errorLogSpy?.mockRestore();
      debugLogSpy?.mockRestore();
      spyOnVictim(opts.victim);
      const mine = newId();
      const competitor = holdCompetitor();
      await competitor.begun;
      let settled = false;
      const victimResult = opts.fire(mine).then(
        (value) => ((settled = true), value),
        (error) => ((settled = true), error)
      );
      if (opts.release === 'onFirstAbort') {
        for (let i = 0; i < 800 && !settled; i++) {
          if (abortObserved()) {
            break;
          }
          await sleep(25);
        }
        competitor.release();
      }
      const outcome = await victimResult;
      if (opts.release === 'never') {
        competitor.release();
      }
      await competitor.done.catch(() => undefined);
      if (abortObserved() && opts.premiseOutcome(outcome)) {
        return { mine, outcome, aborts: lines(debugLogSpy, ABORT_DEBUG_LINE_DML) };
      }
    }
    throw new Error('the emulator did not abort the victim within the try budget');
  };

  const committed = (outcome: unknown): boolean => outcome === 'resolved';
  const budgetError = (outcome: unknown): boolean => (outcome as { code?: number } | undefined)?.code === 4;

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

  beforeEach(() => {
    reportErrorSpy = jest.spyOn(statics.LIVENESS_MONITOR, 'reportError');
  });

  afterEach(() => {
    errorLogSpy?.mockRestore();
    debugLogSpy?.mockRestore();
    reportErrorSpy.mockRestore();
  });

  const assertRetriedAbortsAtDebug = (aborts: LogLine[], mine: string) => {
    expect(aborts.length).toBeGreaterThanOrEqual(1);
    // Attempt numbers run 1, 2, … in order — one per aborted attempt.
    expect(aborts.map((line) => line.obj.attempt)).toEqual(aborts.map((_, index) => index + 1));
    for (const abort of aborts) {
      expect(abort.obj).toEqual(
        expect.objectContaining({
          statement: { operation: 'INSERT', table: table.name },
          cause: expect.objectContaining({ code: 10, status: 'ABORTED' }),
        })
      );
      expect(typeof abort.obj.durationMs).toBe('number');
      // The parameters are DESCRIBED — the row's id (`mine`, a bound value) by its type and length —
      // and nothing on the line quotes it.
      expect(abort.obj.params).toBeDefined();
      const described = Object.values(abort.obj.params as { [name: string]: { type: string; length?: number } });
      expect(described).toContainEqual({ type: 'string', length: mine.length });
      for (const description of described) {
        expect(Object.keys(description).filter((key) => !['type', 'length', 'null'].includes(key))).toEqual([]);
      }
      expect(inspect(abort.obj, { depth: 10, maxStringLength: null })).not.toContain(mine);
      expect(JSON.stringify(abort.obj)).not.toContain(mine);
    }
  };

  test('a multi-statement transaction aborted by a concurrent writer is retried: each retried abort logs at debug, none at error, nothing to the liveness monitor, and it commits', async () => {
    const { mine, aborts } = await contendUntilAborted({
      victim: spannerDriver,
      release: 'onFirstAbort',
      premiseOutcome: committed,
      fire: (id) => settle(spannerDriver.runTransaction((tx) => spannerDriver.runDml(insertRow(id, 'mine'), tx))),
    });

    // Each aborted attempt reached the log at debug; the committed attempt did not.
    assertRetriedAbortsAtDebug(aborts, mine);
    // Never at error, never reported to the liveness monitor: a retried abort is not a failure.
    expect(failureLines(errorLogSpy)).toHaveLength(0);
    expect(errorLogSpy).not.toHaveBeenCalled();
    expect(reportErrorSpy).not.toHaveBeenCalled();
    // The retried attempt committed.
    expect(await namesOf([mine])).toEqual(['mine']);
  }, 120000);

  test('a single-statement DML (runDml outside a transaction) aborted by a concurrent writer is retried the same way: retried abort at debug, none at error, and the row lands', async () => {
    const { mine, aborts } = await contendUntilAborted({
      victim: spannerDriver,
      release: 'onFirstAbort',
      premiseOutcome: committed,
      fire: (id) => settle(spannerDriver.runDml(insertRow(id, 'single'))),
    });

    // The implicit transaction retried its aborted attempt(s) at debug, never at error.
    assertRetriedAbortsAtDebug(aborts, mine);
    expect(failureLines(errorLogSpy)).toHaveLength(0);
    expect(errorLogSpy).not.toHaveBeenCalled();
    expect(reportErrorSpy).not.toHaveBeenCalled();
    // The retried single statement landed.
    expect(await namesOf([mine])).toEqual(['single']);
  }, 120000);

  test('a multi-statement transaction that aborts past the retry budget fails once at error, with the last abort as its cause; the retried attempt stays at debug', async () => {
    const { mine, outcome, aborts } = await contendUntilAborted({
      victim: budgetDriver,
      release: 'never',
      premiseOutcome: budgetError,
      fire: (id) => settle(budgetDriver.runTransaction((tx) => budgetDriver.runDml(insertRow(id, 'mine'), tx))),
    });

    // The throw is the runner's own budget error (code 4), carrying the abort (code 10) that ended
    // the last attempt.
    const failure = outcome as { code?: number; errors?: unknown[] };
    expect(failure.code).toBe(4);
    expect(failure.errors?.[0]).toBeInstanceOf(SpannerOperationError);
    expect((failure.errors?.[0] as SpannerOperationError).code).toBe(10);
    // The one attempt's abort logged at debug; the budget's exhaustion is the ONE error line.
    expect(aborts).toHaveLength(1);
    assertRetriedAbortsAtDebug(aborts, mine);
    expect(failureLines(errorLogSpy)).toHaveLength(0);
    const budgetLines = lines(errorLogSpy, 'Transaction retry budget exhausted: spanner transaction');
    expect(budgetLines).toHaveLength(1);
    expect(errorLogSpy).toHaveBeenCalledTimes(1);
    expect(budgetLines[0].error).toBe(outcome);
    expect(budgetLines[0].obj).toEqual(
      expect.objectContaining({
        attempts: 1,
        budgetMs: 1,
        statement: { operation: 'INSERT', table: table.name },
        cause: expect.objectContaining({ code: 10, status: 'ABORTED' }),
      })
    );
    expect(typeof budgetLines[0].obj.durationMs).toBe('number');
    // Nothing of the given-up transaction landed.
    expect(await namesOf([mine])).toEqual([]);
  }, 120000);

  test('a single-statement DML that aborts past the retry budget fails once at error too (the dml-transaction op), the retried abort at debug', async () => {
    const { mine, outcome, aborts } = await contendUntilAborted({
      victim: budgetDriver,
      release: 'never',
      premiseOutcome: budgetError,
      fire: (id) => settle(budgetDriver.runDml(insertRow(id, 'single'))),
    });

    const failure = outcome as { code?: number; errors?: unknown[] };
    expect(failure.code).toBe(4);
    expect((failure.errors?.[0] as SpannerOperationError).code).toBe(10);
    expect(aborts).toHaveLength(1);
    assertRetriedAbortsAtDebug(aborts, mine);
    expect(failureLines(errorLogSpy)).toHaveLength(0);
    const budgetLines = lines(errorLogSpy, 'Transaction retry budget exhausted: spanner dml transaction');
    expect(budgetLines).toHaveLength(1);
    expect(errorLogSpy).toHaveBeenCalledTimes(1);
    expect(budgetLines[0].obj).toEqual(
      expect.objectContaining({
        attempts: 1,
        budgetMs: 1,
        statement: { operation: 'INSERT', table: table.name },
        cause: expect.objectContaining({ code: 10, status: 'ABORTED' }),
      })
    );
    // The aborted single statement did not land.
    expect(await namesOf([mine])).toEqual([]);
  }, 120000);

  test('a failure the runner does not retry inside the same transaction still logs at error once (a duplicate key), and is never mistaken for a retried abort', async () => {
    const existing = await db.insert(table, { name: 'first' });
    spyOnVictim(spannerDriver);
    let bodyRuns = 0;

    const outcome = await settle(
      spannerDriver.runTransaction(async (transaction) => {
        bodyRuns += 1;
        await spannerDriver.runDml(insertRow(existing.id, 'again'), transaction);
      })
    );

    expect(bodyRuns).toBe(1);
    expect(outcome).toBeInstanceOf(SpannerOperationError);
    expect((outcome as SpannerOperationError).code).toBe(6);
    const failures = failureLines(errorLogSpy);
    expect(failures).toHaveLength(1);
    expect(failures[0].obj.cause).toEqual(expect.objectContaining({ code: 6, status: 'ALREADY_EXISTS' }));
    expect(lines(debugLogSpy, ABORT_DEBUG_LINE_DML)).toHaveLength(0);
    expect(reportErrorSpy).toHaveBeenCalledTimes(1);
  }, 60000);
});
