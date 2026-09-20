import { EventEmitter } from 'events';
import { Database } from '@google-cloud/spanner';
import { DeadlineError } from '@google-cloud/spanner/build/src/transaction-runner';
import { SpannerDriver, SpannerLivenessMonitor, SpannerLogValues } from '@proteinjs/db-driver-spanner';
import { Logger } from '@proteinjs/logger';
import { CapturedLog, lineOf, printed } from './util/printedLine';

/**
 * The dev-only values switch (`SpannerLogValues`): the driver's lines carry REAL values — a
 * statement's bound parameters, the backend's own message — only when BOTH `DEVELOPMENT` is set AND
 * `DB_LOG_PARAM_VALUES=1`. With either gate closed: never, at any level, on any line.
 *
 * By default a line describes the parameters and names a failure in the driver's words (the rest
 * of this lane's suites hold that). On an emulator or a local dev database the values are what
 * locates a bug, so there — and only there — the lines add `paramValues` and `vendorMessage`.
 *
 * Every gate is driven through the driver's real doors with the vendor client's rejection stubbed
 * in place of the RPC, the lines captured at the log WRITER with the logger at debug, and judged
 * as the text a writer would print (printedLine.ts). The error a caller CATCHES stays value-free
 * with the switch on: the switch adds fields to lines and changes nothing else.
 */

// Fixture values shaped like row content (none is a real credential).
const VALUE = 'rst_5d41402abc4b2a76b9719d911017c592';
const BACKEND_WORDS = 'Failed to insert row with primary key';
const vendor = (code: number, message: string) => Object.assign(new Error(message), { code, details: message });
const duplicate = () => vendor(6, `6 ALREADY_EXISTS: ${BACKEND_WORDS} ({pk#id:"${VALUE}"})`);
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

describe('the dev-only values switch: real values ride the driver`s lines only behind both gates', () => {
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
  const capturingLogger = (name: string) =>
    new Logger({ name, logLevel: 'debug', logWriter: { write: (log: CapturedLog) => captured.push(log) } as any });

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
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  const params = { id: VALUE, n: 42 };
  const dml = () => ({
    sql: 'INSERT INTO `credential` (`id`, `n`) VALUES (@id, @n)',
    namedParams: { params, types: { id: 'string', n: 'int64' } },
  });
  const query = () => ({
    sql: 'SELECT `n` FROM `credential` WHERE `id` = @id AND `n` = @n',
    namedParams: { params, types: { id: 'string', n: 'int64' } },
  });

  /** Every line the driver writes about a statement or a failure, provoked once; the errors callers caught. */
  const driveEveryLine = async (): Promise<unknown[]> => {
    statics.LIVENESS_MONITOR = fakeMonitor;
    const driver = new SpannerDriver({ projectId: 'fake', instanceName: 'fake', databaseName: 'fake' });
    (driver as unknown as { logger: Logger }).logger = capturingLogger('SpannerDriver');
    const caught: unknown[] = [];

    // A statement on a caller's transaction, and a query outside one: the debug line beside the op, the failure line.
    caught.push(await settle(driver.runDml(dml, { batchUpdate: () => Promise.reject(duplicate()) } as any)));
    statics.SPANNER_DB = { run: () => Promise.reject(duplicate()) };
    caught.push(await settle(driver.runQuery(query)));

    // The driver's own transaction: an abort the runner retries (debug), a rollback that fails
    // (debug), and the runner giving up on its budget (error).
    const aborted = () => vendor(10, `10 ABORTED: Transaction was aborted on keys in range [[${VALUE}], [${VALUE}])`);
    const transaction = {
      batchUpdate: () => Promise.reject(aborted()),
      commit: () => Promise.resolve(),
      rollback: () => Promise.reject(aborted()),
    };
    statics.SPANNER_DB = {
      runTransactionAsync: (_options: unknown, body: (handle: unknown) => Promise<unknown>) =>
        body(transaction).catch((lastAbort: Error) => {
          throw new DeadlineError(lastAbort as any);
        }),
    };
    caught.push(((await settle(driver.runDml(dml))) as DeadlineError).errors[0]);

    // A schema update.
    statics.SPANNER_DB = {
      updateSchema: () =>
        Promise.reject(
          vendor(9, `9 FAILED_PRECONDITION: Found uniqueness violation on index ix, duplicate key: ${VALUE}`)
        ),
    };
    caught.push(await settle(driver.runUpdateSchema('CREATE UNIQUE INDEX ix ON credential (id)')));

    // The liveness monitor: a pool background error, then a failed probe.
    jest.useFakeTimers();
    const database = Object.assign(new EventEmitter(), {
      pool_: { size: 1, available: 1, borrowed: 0, totalPending: 0, totalWaiters: 0 },
    });
    const monitor = new SpannerLivenessMonitor(database as unknown as Database);
    const monitorInternals = monitor as unknown as { logger: Logger; probe(): Promise<void>; exit(): void };
    monitorInternals.logger = capturingLogger('SpannerLivenessMonitor');
    jest.spyOn(monitorInternals, 'exit').mockImplementation(() => undefined);
    jest.spyOn(monitorInternals, 'probe').mockRejectedValue(vendor(14, `14 UNAVAILABLE: no route to ${VALUE}`));
    monitor.start();
    database.emit('error', vendor(9, `9 FAILED_PRECONDITION: session holds ${VALUE}`));
    await jest.advanceTimersByTimeAsync(110_000);
    jest.useRealTimers();
    return caught;
  };

  const STATEMENT_LINES = ['Executing dml', 'Executing query'];
  const FAILURE_LINES = [
    'Failed when executing dml',
    'Failed when executing query',
    'Transaction aborted at dml; the transaction runner retries it',
    'Rollback after transaction error failed',
    'Transaction retry budget exhausted: spanner dml transaction',
    'Failed when executing schema update',
    'Spanner session pool emitted a background error; verifying db connectivity',
    'Db connectivity probe failed',
  ];
  const linesNamed = (message: string) => captured.filter((log) => log.message === message);

  test.each(GATES)('%s', async (_gate, env, on) => {
    Object.assign(process.env, env);

    const caught = await driveEveryLine();

    expect(SpannerLogValues.enabled()).toBe(on);
    // The premise, at every gate: each line under test was written.
    for (const message of [...STATEMENT_LINES, ...FAILURE_LINES]) {
      expect({ message, written: linesNamed(message).length > 0 }).toEqual({ message, written: true });
    }
    // What a caller catches is value-free whatever the switch says.
    expect(caught).toHaveLength(4);
    for (const error of caught) {
      expect(error).toBeInstanceOf(Error);
      expect(printed(error)).not.toContain(VALUE);
      expect(printed(error)).not.toContain(BACKEND_WORDS);
    }
    if (!on) {
      for (const log of captured) {
        expect(lineOf(log)).not.toContain(VALUE);
        expect(lineOf(log)).not.toContain(BACKEND_WORDS);
        expect(Object.keys(log.obj ?? {})).not.toContain('paramValues');
        expect(Object.keys(log.obj ?? {})).not.toContain('vendorMessage');
      }
      return;
    }
    for (const message of [...STATEMENT_LINES, ...FAILURE_LINES.slice(0, 3)]) {
      for (const log of linesNamed(message)) {
        // The values as bound, BESIDE the description — which stays.
        expect({ message, paramValues: log.obj.paramValues }).toEqual({ message, paramValues: params });
        expect(log.obj.params).toEqual({ id: { type: 'string', length: VALUE.length }, n: { type: 'int64' } });
      }
    }
    for (const message of FAILURE_LINES) {
      for (const log of linesNamed(message)) {
        // The backend's message as it arrived, BESIDE the driver's summary — which stays.
        expect({ message, vendorMessage: log.obj.vendorMessage }).toEqual({
          message,
          vendorMessage: expect.stringContaining(VALUE),
        });
        expect(log.obj.cause).toEqual(expect.objectContaining({ failureClass: expect.any(String) }));
      }
    }
    expect(linesNamed('Failed when executing dml')[0].obj.vendorMessage).toBe(duplicate().message);
  });
});
