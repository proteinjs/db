import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { Logger } from '@proteinjs/logger';
import { CapturedLog, lineOf } from './util/printedLine';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';

/**
 * The backend's own message never reaches a LOG LINE — the driver's own lines, and any line a
 * caller writes about the error it caught — while what the driver THROWS is what it always threw
 * (ThrownErrorIdentity.test.ts holds the thrown error to the recorded release line; here the
 * premise of every scenario is that the caught error still carries the backend's words).
 *
 * The backend echoes the value it choked on, and often BARE, where no mask over quoted, braced
 * or bracketed text can find it: a string bound where a TIMESTAMP, INT64, FLOAT64, DATE or
 * NUMERIC is declared comes back as `Could not parse <value> as a TIMESTAMP`; a failed CAST as
 * `Bad int64 value: <value>`; `ERROR(@p)` as the value and nothing else; a unique-index backfill
 * over duplicate rows as `duplicate key: {String("<row value>")}` on the schema-update line.
 *
 * So a line carries the failure's CODE and the driver's own sentence, and nothing the backend
 * worded. Every scenario runs for real on the emulator, captures the driver's lines at the log
 * WRITER with the logger at debug, then logs the caught error the way a caller would — whole, as
 * a line's `error` and inside its `obj` — through a logger of the caller's own, and judges each
 * line as the text a writer would print (printedLine.ts).
 */

const spannerConfig = { projectId: 'proteinjs-test', instanceName: 'proteinjs-test', databaseName: 'test' };
const TYPED_TABLE = 'db_test_backend_line_typed';
const DUPLICATES_TABLE = 'db_test_backend_line_duplicates';

// Fixture values shaped like the row content that must never be printed (none is a real credential).
const valueFor = (tag: string) => `rst_${tag}_5d41402abc4b2a76b9719d911017c592`;
// The backend cuts a long echo short, and the head of a value is as much a leak as the whole of it.
const headOf = (value: string) => value.slice(0, 24);

const settle = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(() => 'resolved' as const).catch((error: unknown) => error);

describe('the backend`s message never reaches a log line; the thrown error still carries it (emulator)', () => {
  const spannerDriver = new SpannerDriver(spannerConfig);
  const internals = spannerDriver as unknown as { logger: Logger };
  let captured: CapturedLog[] = [];
  let driverLogger: Logger;
  const capturing = (name: string) =>
    new Logger({
      name,
      logLevel: 'debug',
      logWriter: { write: (log: CapturedLog) => captured.push(log) } as any,
    });
  const callerLogger = capturing('ACaller');

  const quietly = async (work: () => Promise<unknown>) => {
    const quiet = jest.spyOn(internals.logger, 'error').mockImplementation(() => undefined);
    await work().catch(() => undefined);
    quiet.mockRestore();
  };

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await spannerDriver.createDbIfNotExists();
    await quietly(() => spannerDriver.runUpdateSchema(`DROP INDEX ${DUPLICATES_TABLE}_email`));
    await quietly(() => spannerDriver.runUpdateSchema(`DROP TABLE ${DUPLICATES_TABLE}`));
    await quietly(() => spannerDriver.runUpdateSchema(`DROP TABLE ${TYPED_TABLE}`));
    await spannerDriver.runUpdateSchema([
      `CREATE TABLE ${TYPED_TABLE} (id STRING(MAX) NOT NULL, n INT64, f FLOAT64, ts TIMESTAMP, dt DATE, num NUMERIC) PRIMARY KEY (id)`,
      `CREATE TABLE ${DUPLICATES_TABLE} (id STRING(MAX) NOT NULL, email STRING(MAX)) PRIMARY KEY (id)`,
    ]);
    driverLogger = internals.logger;
    internals.logger = capturing('SpannerDriver');
  }, 120000);

  afterAll(async () => {
    internals.logger = driverLogger;
    await quietly(() => spannerDriver.runUpdateSchema(`DROP INDEX ${DUPLICATES_TABLE}_email`));
    await quietly(() => spannerDriver.runUpdateSchema(`DROP TABLE ${DUPLICATES_TABLE}`));
    await quietly(() => spannerDriver.runUpdateSchema(`DROP TABLE ${TYPED_TABLE}`));
    await SpannerEmulatorProvisioner.release();
  }, 120000);

  beforeEach(() => {
    captured = [];
  });

  /**
   * The premise (the caught error carries the backend's echo of `value`), then the law: the
   * caller logs what it caught, and no line — the driver's or the caller's — carries the value.
   */
  const assertNeverOnALine = (caught: unknown, value: string, failureLine: string) => {
    const head = headOf(value);
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toContain(head);

    callerLogger.error({ message: 'A caller`s own line about what it caught', error: caught });
    callerLogger.warn({ message: 'A caller`s own line about what it caught', obj: { caught, list: [caught] } });

    expect(captured.filter((log) => log.logLevel === 'error' && log.message === failureLine)).toHaveLength(1);
    expect(captured.filter((log) => log.message === 'A caller`s own line about what it caught')).toHaveLength(2);
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(head);
    }
    return captured.filter((log) => log.message === failureLine)[0];
  };

  const typedInsert = (params: { [name: string]: unknown }, transaction?: any) =>
    spannerDriver.runDml(
      () => ({
        sql: `INSERT INTO \`${TYPED_TABLE}\` (\`id\`, \`n\`, \`f\`, \`ts\`, \`dt\`, \`num\`) VALUES (@id, @n, @f, @ts, @dt, @num)`,
        namedParams: {
          params: { id: 'typed-row', n: null, f: null, ts: null, dt: null, num: null, ...params },
          types: { id: 'string', n: 'int64', f: 'float64', ts: 'timestamp', dt: 'date', num: 'numeric' },
        },
      }),
      transaction
    );

  test.each([
    ['int64', 'n'],
    ['float64', 'f'],
    ['timestamp', 'ts'],
    ['date', 'dt'],
    ['numeric', 'num'],
  ])(
    'a string bound to a %s parameter of a dml is echoed bare by the backend — and rides no line',
    async (type, param) => {
      const value = valueFor(type);

      const caught = await settle(typedInsert({ [param]: value }));

      const line = assertNeverOnALine(caught, value, 'Failed when executing dml');
      // The description beside it is what locates the parameter — without its value.
      expect(line.obj.params[param]).toEqual({ type, length: value.length });
      expect(line.obj.cause).toEqual({
        code: 9,
        status: 'FAILED_PRECONDITION',
        message: 'the statement cannot run against the database as it stands',
      });
      expect(line.error.message).toBe(
        `Failed when executing dml (FAILED_PRECONDITION, code 9) on INSERT ${TYPED_TABLE}: the statement cannot run against the database as it stands`
      );
    },
    30000
  );

  test.each([
    ['DEVELOPMENT set AND DB_LOG_PARAM_VALUES=1', { DEVELOPMENT: 'true', DB_LOG_PARAM_VALUES: '1' }, true],
    ['DEVELOPMENT unset, DB_LOG_PARAM_VALUES=1', { DB_LOG_PARAM_VALUES: '1' }, false],
    ['DEVELOPMENT set, DB_LOG_PARAM_VALUES unset', { DEVELOPMENT: 'true' }, false],
  ])(
    'the backend`s text rides a line only behind the dev-only values switch — %s',
    async (_gate, env: { [name: string]: string }, open) => {
      const value = valueFor('switch');
      const before = { DEVELOPMENT: process.env.DEVELOPMENT, DB_LOG_PARAM_VALUES: process.env.DB_LOG_PARAM_VALUES };
      delete process.env.DEVELOPMENT;
      delete process.env.DB_LOG_PARAM_VALUES;
      Object.assign(process.env, env);
      try {
        const caught = await settle(typedInsert({ ts: value }));
        callerLogger.error({ message: 'A caller`s own line', error: caught });

        const [callersLine] = captured.filter((log) => log.message === 'A caller`s own line');
        const [failure] = captured.filter((log) => log.message === 'Failed when executing dml');
        if (open) {
          expect(callersLine.error).toBe(caught);
          expect(failure.error).toBe(caught);
          expect(failure.obj.cause.message).toContain(headOf(value));
        } else {
          expect(callersLine.error).not.toBe(caught);
          expect(failure.obj.cause.message).toBe('the statement cannot run against the database as it stands');
          for (const log of captured) {
            expect(lineOf(log)).not.toContain(headOf(value));
          }
        }
      } finally {
        for (const [name, each] of Object.entries(before)) {
          if (each === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = each;
          }
        }
      }
    },
    30000
  );

  test('the vendor error UNDER the typed one — what a caller reaches as `caught.cause` — rides no line either, logged on its own', async () => {
    const value = valueFor('cause_alone');

    const caught = (await settle(typedInsert({ ts: value }))) as Error & { cause: Error };

    // The premise: the typed error's cause is the vendor's own error, and it carries the echo.
    expect(caught.cause).toBeInstanceOf(Error);
    expect(caught.cause).not.toBe(caught);
    expect(String(caught.cause.message)).toContain(headOf(value));
    captured = [];

    callerLogger.error({ message: 'A caller`s line about the cause alone', error: caught.cause });
    callerLogger.warn({ message: 'A caller`s line about the cause alone', obj: { cause: caught.cause } });

    expect(captured).toHaveLength(2);
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(headOf(value));
    }
    expect(captured[0].error.message).toBe(
      'Failed when executing dml (FAILED_PRECONDITION, code 9): the statement cannot run against the database as it stands'
    );
    expect(captured[1].obj.cause.message).toBe(captured[0].error.message);
  }, 30000);

  test('the same inside a transaction the driver runs', async () => {
    const value = valueFor('transaction');

    const caught = await settle(
      spannerDriver.runTransaction(async (transaction) => {
        await typedInsert({ n: value }, transaction);
      })
    );

    assertNeverOnALine(caught, value, 'Failed when executing dml');
  }, 30000);

  test.each([
    ['CAST(@p AS INT64)', 'cast'],
    ['ERROR(@p)', 'error_function'],
  ])(
    'a runtime failure over a bound value — %s — rides no line',
    async (expression, tag) => {
      const value = valueFor(tag);

      const caught = await settle(
        spannerDriver.runQuery(() => ({
          sql: `SELECT ${expression} AS v`,
          namedParams: { params: { p: value }, types: { p: 'string' } },
        }))
      );

      assertNeverOnALine(caught, value, 'Failed when executing query');
    },
    30000
  );

  test('a schema update that fails on row data — a unique index over duplicate rows — names the statement, never the duplicate value', async () => {
    const value = valueFor('duplicate_row');
    await spannerDriver.runDml(() => ({
      sql: `INSERT INTO \`${DUPLICATES_TABLE}\` (\`id\`, \`email\`) VALUES (@a, @email), (@b, @email)`,
      namedParams: {
        params: { a: 'dup-a', b: 'dup-b', email: value },
        types: { a: 'string', b: 'string', email: 'string' },
      },
    }));
    captured = [];

    const caught = await settle(
      spannerDriver.runUpdateSchema(`CREATE UNIQUE INDEX ${DUPLICATES_TABLE}_email ON ${DUPLICATES_TABLE} (email)`)
    );

    const line = assertNeverOnALine(caught, value, 'Failed when executing schema update');
    expect(line.obj.statements).toEqual([
      `CREATE UNIQUE INDEX ${DUPLICATES_TABLE}_email ON ${DUPLICATES_TABLE} (email)`,
    ]);
  }, 60000);
});

/**
 * The doors an emulator cannot be driven through — a refused commit, the runner's spent budget, a
 * failed rollback, a failure the client library raises around the body, the env-token auth
 * error, a connectivity probe — with the vendor client's rejection stubbed in place of the RPC.
 * The stubbed backend quotes the bound value BARE in every message.
 */
describe('the backend`s message never reaches a log line — the doors only a stub can force', () => {
  type DriverStatics = {
    SPANNER_DB?: unknown;
    LIVENESS_MONITOR?: unknown;
    ENV_TOKEN_AUTH?: unknown;
    CONSECUTIVE_DEADLINE_FAILURES: number;
  };
  const statics = SpannerDriver as unknown as DriverStatics;
  const fakeMonitor = {
    logPoolPressure: () => undefined,
    poolStats: () => ({ size: 0, available: 0, borrowed: 0, pending: 0, totalWaiters: 0 }),
    reportError: () => undefined,
    stop: () => undefined,
  };
  const VALUE = valueFor('stubbed');
  const vendor = (code: number, message: string) => Object.assign(new Error(message), { code, details: message });
  const echoing = (code: number, status: string) =>
    vendor(code, `${code} ${status}: Could not parse ${VALUE} as a TIMESTAMP`);
  const dml = () => ({
    sql: 'INSERT INTO `ledger` (`id`) VALUES (@id)',
    namedParams: { params: { id: VALUE }, types: { id: 'string' } },
  });
  let captured: CapturedLog[] = [];
  const capturing = (name: string) =>
    new Logger({ name, logLevel: 'debug', logWriter: { write: (log: CapturedLog) => captured.push(log) } as any });
  const callerLogger = capturing('ACaller');
  let driver: SpannerDriver;

  beforeEach(() => {
    captured = [];
    statics.LIVENESS_MONITOR = fakeMonitor;
    driver = new SpannerDriver({ projectId: 'fake', instanceName: 'fake', databaseName: 'fake' });
    (driver as unknown as { logger: Logger }).logger = capturing('SpannerDriver');
  });

  afterEach(() => {
    statics.SPANNER_DB = undefined;
    statics.LIVENESS_MONITOR = undefined;
    statics.ENV_TOKEN_AUTH = undefined;
    statics.CONSECUTIVE_DEADLINE_FAILURES = 0;
  });

  /** The premise (what was caught carries the echo), then: the caller logs it, and no line carries the value. */
  const assertNeverOnALine = (caught: unknown, carrier: unknown = caught) => {
    expect(String((carrier as Error).message)).toContain(VALUE);
    callerLogger.error({ message: 'A caller`s own line', error: caught, obj: { caught } });
    expect(captured.filter((log) => log.message === 'A caller`s own line')).toHaveLength(1);
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(VALUE);
    }
    return captured.filter((log) => log.message === 'A caller`s own line')[0];
  };

  const runningBodyOnce = (transaction: unknown) => ({
    runTransactionAsync: (_options: unknown, body: (handle: unknown) => Promise<unknown>) => body(transaction),
  });

  test('a commit the backend refuses: the vendor`s own error is thrown as it is, and reads on a line as the commit`s status and sentence', async () => {
    const refused = echoing(9, 'FAILED_PRECONDITION');
    statics.SPANNER_DB = runningBodyOnce({
      batchUpdate: () => Promise.resolve([[1]]),
      commit: () => Promise.reject(refused),
      rollback: () => Promise.resolve(),
    });

    const caught = await settle(driver.runTransaction((transaction) => driver.runDml(dml, transaction)));

    expect(caught).toBe(refused);
    const line = assertNeverOnALine(caught);
    expect(line.error.message).toBe(
      'Transaction commit failed (FAILED_PRECONDITION, code 9): the statement cannot run against the database as it stands'
    );
  });

  test('a rollback the backend refuses: the debug line carries the stand-in', async () => {
    const callersOwn = new Error('The order is already closed');
    statics.SPANNER_DB = runningBodyOnce({
      rollback: () => Promise.reject(echoing(13, 'INTERNAL')),
    });

    const caught = await settle(
      driver.runTransaction(async () => {
        throw callersOwn;
      })
    );
    callerLogger.error({ message: 'A caller`s own line', error: caught });

    const [rollbackLine] = captured.filter((log) => log.message === 'Rollback after transaction error failed');
    expect(rollbackLine.obj.rollbackError.message).toBe(
      'Transaction rollback failed (INTERNAL, code 13): the database or the connection to it failed internally'
    );
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(VALUE);
    }
    // What the BODY threw is the caller's own error: thrown as it is, and printed as it is.
    expect(caught).toBe(callersOwn);
    expect(captured.filter((log) => log.message === 'A caller`s own line')[0].error).toBe(callersOwn);
  });

  test('the runner`s spent budget: its error carries the last abort among its `errors`, and rides the budget line and a caller`s line as a stand-in', async () => {
    const { DeadlineError } = require('@google-cloud/spanner/build/src/transaction-runner');
    const transaction = {
      batchUpdate: () => Promise.reject(vendor(10, `10 ABORTED: Transaction was aborted on key ${VALUE}`)),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
    };
    statics.SPANNER_DB = {
      runTransactionAsync: (_options: unknown, body: (handle: unknown) => Promise<unknown>) =>
        body(transaction).catch((lastAbort: Error) => {
          throw new DeadlineError(lastAbort as any);
        }),
    };

    const caught = await settle(driver.runTransaction((handle) => driver.runDml(dml, handle)));

    expect(caught).toBeInstanceOf(DeadlineError);
    const line = assertNeverOnALine(caught, (caught as { errors: unknown[] }).errors[0]);
    expect(line.error.message).toBe(
      'Transaction failed: spanner transaction (DEADLINE_EXCEEDED, code 4): the call did not finish within its deadline'
    );
    const [budgetLine] = captured.filter((log) => /^Transaction retry budget exhausted/.test(log.message ?? ''));
    expect(budgetLine.obj.cause).toEqual({ code: 10, status: 'ABORTED', message: 'the transaction was aborted' });
  });

  test('a failure the client library raises around the body (no session, no transaction) is marked at the transaction`s door', async () => {
    const raised = vendor(5, `5 NOT_FOUND: Database not found while binding ${VALUE}`);
    statics.SPANNER_DB = { runTransactionAsync: () => Promise.reject(raised) };

    const caught = await settle(driver.runTransaction(async () => 'never runs'));

    expect(caught).toBe(raised);
    assertNeverOnALine(caught);
  });

  test('the env-token auth error repeats the backend`s message: it reads on a line under the vendor error`s status', async () => {
    statics.ENV_TOKEN_AUTH = { invalidate: () => undefined };
    statics.SPANNER_DB = { run: () => Promise.reject(vendor(16, `16 UNAUTHENTICATED: bad token near ${VALUE}`)) };

    const caught = await settle(
      driver.runQuery(() => ({ sql: 'SELECT 1', namedParams: { params: { id: VALUE }, types: { id: 'string' } } }))
    );

    expect((caught as Error).name).toBe('SpannerEnvTokenAuthError');
    const line = assertNeverOnALine(caught);
    expect(line.error.message).toBe(
      'The env-delivered access token was rejected (UNAUTHENTICATED, code 16): the credentials of the caller were not accepted'
    );
  });

  test('the driver`s own op-deadline error quotes nothing of the backend`s: it is not marked, and a line about it says what the driver said', async () => {
    statics.SPANNER_DB = { run: () => new Promise(() => undefined) };
    driver = new SpannerDriver({
      projectId: 'fake',
      instanceName: 'fake',
      databaseName: 'fake',
      operationDeadlineMs: 20,
    });
    (driver as unknown as { logger: Logger }).logger = capturing('SpannerDriver');

    const caught = (await settle(
      driver.runQuery(() => ({ sql: 'SELECT 1', namedParams: { params: {}, types: {} } }))
    )) as Error & { cause: Error };
    callerLogger.error({ message: 'A caller`s own line', error: caught, obj: { cause: caught.cause } });

    expect(caught.message).toContain('exceeded its 20ms deadline');
    const [callersLine] = captured.filter((log) => log.message === 'A caller`s own line');
    expect(callersLine.error).toBe(caught);
    expect(callersLine.obj.cause).toBe(caught.cause);
    const [failure] = captured.filter((log) => log.message === 'Failed when executing query');
    expect(failure.error).toBe(caught);
  });

  test('a connectivity probe that fails: the line carries the status and the sentence', async () => {
    jest.useFakeTimers();
    try {
      const { SpannerLivenessMonitor } = require('@proteinjs/db-driver-spanner');
      const monitor = new SpannerLivenessMonitor({});
      (monitor as { logger: Logger }).logger = capturing('SpannerLivenessMonitor');
      jest.spyOn(monitor, 'exit').mockImplementation(() => undefined);
      jest.spyOn(monitor, 'probe').mockRejectedValue(vendor(14, `14 UNAVAILABLE: no route while sending ${VALUE}`));

      const check = monitor.verifyLiveness();
      await jest.advanceTimersByTimeAsync(110_000);
      await check;

      const probeLines = captured.filter((log) => log.message === 'Db connectivity probe failed');
      expect(probeLines.length).toBeGreaterThan(0);
      expect(probeLines[0].obj.cause).toEqual({
        code: 14,
        status: 'UNAVAILABLE',
        message: 'the database could not be reached',
      });
      for (const log of captured) {
        expect(lineOf(log)).not.toContain(VALUE);
      }
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });
});
