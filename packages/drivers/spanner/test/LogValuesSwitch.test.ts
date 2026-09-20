import { DeadlineError } from '@google-cloud/spanner/build/src/transaction-runner';
import { SpannerDriver, SpannerLogValues } from '@proteinjs/db-driver-spanner';
import { Logger } from '@proteinjs/logger';
import { CapturedLog, lineOf, printed } from './util/printedLine';

/**
 * The dev-only values switch (`SpannerLogValues`): the driver's statement lines carry the REAL
 * values of the bound parameters only when BOTH `DEVELOPMENT` is set AND `DB_LOG_PARAM_VALUES=1`.
 * With either gate closed: never, at any level, on any line.
 *
 * By default a line describes the parameters (StatementParamLogging.test.ts holds that). On an
 * emulator or a local dev database the values are what locates a bug, so there — and only there —
 * the lines add `paramValues` beside the description, which stays.
 *
 * Every gate is driven through the driver's real doors with the vendor client's rejection stubbed
 * in place of the RPC, the lines captured at the log WRITER with the logger at debug, and judged
 * as the text a writer would print (printedLine.ts). The stubbed backend messages quote no bound
 * value: what the BACKEND echoes is not this switch's subject (see StatementParamLogging.test.ts's
 * header). What a caller CATCHES is the same error whatever the switch says: the switch adds a
 * field to lines and changes nothing else.
 */

// A fixture value shaped like row content (not a real credential).
const VALUE = 'rst_5d41402abc4b2a76b9719d911017c592';
const vendor = (code: number, message: string) => Object.assign(new Error(message), { code, details: message });
const tableMissing = () => vendor(5, '5 NOT_FOUND: Table not found: credential');
const aborted = () => vendor(10, '10 ABORTED: Transaction was aborted.');
const settle = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(() => 'resolved' as const).catch((error: unknown) => error);

const GATES: [string, { [name: string]: string }, boolean][] = [
  ['DEVELOPMENT set AND DB_LOG_PARAM_VALUES=1', { DEVELOPMENT: 'true', DB_LOG_PARAM_VALUES: '1' }, true],
  ['DEVELOPMENT unset, DB_LOG_PARAM_VALUES=1', { DB_LOG_PARAM_VALUES: '1' }, false],
  ['DEVELOPMENT empty, DB_LOG_PARAM_VALUES=1', { DEVELOPMENT: '', DB_LOG_PARAM_VALUES: '1' }, false],
  ['DEVELOPMENT set, DB_LOG_PARAM_VALUES unset', { DEVELOPMENT: 'true' }, false],
  [
    'DEVELOPMENT set, DB_LOG_PARAM_VALUES=true (on only as exactly 1)',
    { DEVELOPMENT: 'true', DB_LOG_PARAM_VALUES: 'true' },
    false,
  ],
  ['DEVELOPMENT set, DB_LOG_PARAM_VALUES=0', { DEVELOPMENT: 'true', DB_LOG_PARAM_VALUES: '0' }, false],
  ['neither set', {}, false],
];

describe('the dev-only values switch: real values ride the driver`s statement lines only behind both gates', () => {
  type DriverStatics = { SPANNER_DB?: unknown; LIVENESS_MONITOR?: unknown; CONSECUTIVE_DEADLINE_FAILURES: number };
  const statics = SpannerDriver as unknown as DriverStatics;
  const fakeMonitor = {
    logPoolPressure: () => undefined,
    poolStats: () => ({ size: 0, available: 0, borrowed: 0, pending: 0, totalWaiters: 0 }),
    reportError: () => undefined,
    stop: () => undefined,
  };
  const ENV = [SpannerLogValues.DEVELOPMENT_VAR, SpannerLogValues.SWITCH_VAR];
  const envBefore: { [name: string]: string | undefined } = {};
  let captured: CapturedLog[] = [];

  beforeEach(() => {
    captured = [];
    for (const name of ENV) {
      envBefore[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of ENV) {
      if (envBefore[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = envBefore[name];
      }
    }
    statics.SPANNER_DB = undefined;
    statics.LIVENESS_MONITOR = undefined;
    // The runner's budget error is a DEADLINE_EXCEEDED, which the driver counts toward a client
    // recycle; one per gate here must never add up to recycling the stub.
    statics.CONSECUTIVE_DEADLINE_FAILURES = 0;
  });

  const params = { id: VALUE, n: 42 };
  const types = { id: 'string', n: 'int64' };
  const dml = () => ({
    sql: 'INSERT INTO `credential` (`id`, `n`) VALUES (@id, @n)',
    namedParams: { params, types },
  });
  const query = () => ({
    sql: 'SELECT `n` FROM `credential` WHERE `id` = @id AND `n` = @n',
    namedParams: { params, types },
  });

  /** Every line the driver writes about a statement, provoked once; and the errors callers caught. */
  const driveEveryStatementLine = async (): Promise<unknown[]> => {
    statics.LIVENESS_MONITOR = fakeMonitor;
    const driver = new SpannerDriver({ projectId: 'fake', instanceName: 'fake', databaseName: 'fake' });
    (driver as unknown as { logger: Logger }).logger = new Logger({
      name: 'SpannerDriver',
      logLevel: 'debug',
      logWriter: { write: (log: CapturedLog) => captured.push(log) } as any,
    });
    const caught: unknown[] = [];

    // A statement on a caller's transaction, and a query outside one: the debug line beside the op, the failure line.
    caught.push(await settle(driver.runDml(dml, { batchUpdate: () => Promise.reject(tableMissing()) } as any)));
    statics.SPANNER_DB = { run: () => Promise.reject(tableMissing()) };
    caught.push(await settle(driver.runQuery(query)));

    // The driver's own transaction: an abort the runner retries — the retried-abort line (debug).
    const transaction = {
      batchUpdate: () => Promise.reject(aborted()),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
    };
    statics.SPANNER_DB = {
      runTransactionAsync: (_options: unknown, body: (handle: unknown) => Promise<unknown>) =>
        body(transaction).catch((lastAbort: Error) => {
          throw new DeadlineError(lastAbort as any);
        }),
    };
    caught.push(((await settle(driver.runDml(dml))) as DeadlineError).errors[0]);
    return caught;
  };

  const STATEMENT_LINES = [
    'Executing dml',
    'Executing query',
    'Failed when executing dml',
    'Failed when executing query',
    'Transaction aborted at dml; the transaction runner retries it',
  ];
  const linesNamed = (message: string) => captured.filter((log) => log.message === message);
  /** What a caller can read off a caught error, however it looks. */
  const facts = (error: any) => ({
    class: error?.constructor?.name,
    message: error?.message,
    code: error?.code,
    own: Object.getOwnPropertyNames(error ?? {}).sort(),
  });

  test.each(GATES)('%s', async (_gate, env, on) => {
    // The errors callers catch with the switch untouched — what every gate must reproduce.
    const baseline = (await driveEveryStatementLine()).map(facts);
    captured = [];
    Object.assign(process.env, env);

    const caught = await driveEveryStatementLine();

    expect(SpannerLogValues.enabled()).toBe(on);
    // The premise, at every gate: each line under test was written.
    for (const message of STATEMENT_LINES) {
      expect({ message, written: linesNamed(message).length > 0 }).toEqual({ message, written: true });
    }
    // What a caller catches is the same whatever the switch says, and never carries the value.
    expect(caught).toHaveLength(3);
    expect(caught.map(facts)).toEqual(baseline);
    for (const error of caught) {
      expect(error).toBeInstanceOf(Error);
      expect(printed(error)).not.toContain(VALUE);
    }
    for (const message of STATEMENT_LINES) {
      for (const log of linesNamed(message)) {
        // The description rides every statement line at every gate.
        expect({ message, params: log.obj.params }).toEqual({
          message,
          params: { id: { type: 'string', length: VALUE.length }, n: { type: 'int64' } },
        });
      }
    }
    if (!on) {
      for (const log of captured) {
        expect(lineOf(log)).not.toContain(VALUE);
        expect(Object.keys(log.obj ?? {})).not.toContain('paramValues');
      }
      return;
    }
    for (const message of STATEMENT_LINES) {
      for (const log of linesNamed(message)) {
        // The values as bound, BESIDE the description.
        expect({ message, paramValues: log.obj.paramValues }).toEqual({ message, paramValues: params });
      }
    }
  });

  test('the gates are read at each line: flipped on mid-process the next line carries the values, closed again it stops', async () => {
    await driveEveryStatementLine();
    expect(captured.some((log) => lineOf(log).includes(VALUE))).toBe(false);

    captured = [];
    Object.assign(process.env, { DEVELOPMENT: 'true', DB_LOG_PARAM_VALUES: '1' });
    await driveEveryStatementLine();
    expect(linesNamed('Executing dml')[0].obj.paramValues).toEqual(params);

    captured = [];
    delete process.env.DB_LOG_PARAM_VALUES;
    await driveEveryStatementLine();
    expect(captured.some((log) => lineOf(log).includes(VALUE))).toBe(false);
  });
});
