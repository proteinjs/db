import { isSessionNotFoundError } from '@google-cloud/spanner/build/src/session-pool';
import { isRetryableInternalError, Runner } from '@google-cloud/spanner/build/src/transaction-runner';
import { grpc } from 'google-gax';
import { SpannerDriver, SpannerOperationError } from '@proteinjs/db-driver-spanner';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';

/**
 * THE RETRY LAW: the typed error leads the client library's transaction runner to exactly the
 * retries the driver led it to while the backend's message still rode the typed error — never
 * fewer, never more. What is bound to a statement never changes whether its transaction is retried.
 *
 * The client library's transaction runner decides a retry by reading the error the transaction's
 * body throws, and the body throws the DRIVER's typed error (`SpannerOperationError`), never the
 * vendor's. Read in the client library's source (7.5.0): an ABORTED is retried on its `code` alone
 * and backed off by the `google.rpc.retryinfo-bin` metadata entry — both ride the typed error
 * structurally. A reset stream and a lost session have NO structural signal: `Runner.run` retries
 * `code === INTERNAL && message.includes(<one of four stream-reset literals>)`, and
 * `Database.runTransactionAsync` re-runs on a fresh session for `code === NOT_FOUND &&
 * message.includes('Session not found')`. So the typed error's message must carry the literal
 * exactly when the vendor's does.
 *
 * Before this contract the driver struck every bound value out of the backend's message BEFORE it
 * recognized the failure's class. A bound value that overlaps a literal — the integer 2 against
 * `HTTP/2 error code: INTERNAL_ERROR`, `on` against `EOS on DATA frame`, `found` against `Session
 * not found` — destroyed the class, the typed message lost the literal, and a transaction the
 * runner would have retried and committed was rejected on its first attempt.
 *
 * So no bound value takes part in recognizing a failure's class. But reading the literal off the
 * backend's RAW message went wrong the other way: the backend ECHOES a bound value, and it prints a
 * key inside quotes, braces or brackets — an interleaved child insert with no parent row answers
 * NOT_FOUND with `Key: {String("<the key>")}`. A key that reads `Session not found` put the literal
 * into the typed message; the runner took a final failure for a lost session and re-ran the
 * transaction on a fresh session without end (nothing in the client library bounds that loop).
 * While the backend's message still rode the typed error it rode MASKED — quoted, braced and
 * bracketed spans blanked — so that transaction was rejected on its first attempt.
 *
 * The contract: a retry signal is recognized by the vendor's own test (its code, its literal
 * anywhere) on the text the runner was shown at that door — at a statement's door the masked,
 * bounded line; no bound value takes part — through the driver's real failure path (`runDml` /
 * `runQuery` → operationFailure, which always hands the statement's bound values to the typed
 * error). TransactionRetryParity.test.ts holds the law scenario by scenario against recorded
 * behaviour; this suite holds both directions by name, and end to end on the emulator.
 */

// The vendor runner's whole retry decision (RETRYABLE codes, a lost session, a reset stream); it reads no instance state.
const shouldRetry = (error: unknown): boolean =>
  (Runner.prototype as unknown as { shouldRetry(error: unknown): boolean }).shouldRetry(error);
const vendor = (code: number, message: string, extra?: object) =>
  Object.assign(new Error(message), { code, details: message }, extra);
const settle = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(() => 'resolved' as const).catch((error: unknown) => error);

/** Bound values that overlap the literals — each alone, then all of them on one statement. */
const OVERLAPPING: unknown[] = [
  2,
  'on',
  'closed',
  'found',
  'error',
  'server',
  'unknown',
  'INTERNAL_ERROR',
  'Session',
  'RST_STREAM',
  'HTTP/2 error code: INTERNAL_ERROR',
  'Session not found',
  'Received unexpected EOS on DATA frame from server',
];
const BOUND_SETS: { [param: string]: unknown }[] = [
  ...OVERLAPPING.map((value) => ({ value })),
  OVERLAPPING.reduce<{ [param: string]: unknown }>((all, value, index) => ({ ...all, [`p${index}`]: value }), {}),
];

describe('through the driver`s real failure path, the vendor runner reads the thrown error as it reads the vendor`s', () => {
  type DriverStatics = { SPANNER_DB?: unknown; LIVENESS_MONITOR?: unknown };
  const statics = SpannerDriver as unknown as DriverStatics;
  const fakeMonitor = {
    logPoolPressure: () => undefined,
    poolStats: () => ({ size: 0, available: 0, borrowed: 0, pending: 0, totalWaiters: 0 }),
    reportError: () => undefined,
    stop: () => undefined,
  };
  let driver: SpannerDriver;

  beforeEach(() => {
    statics.LIVENESS_MONITOR = fakeMonitor;
    driver = new SpannerDriver({ projectId: 'fake', instanceName: 'fake', databaseName: 'fake' });
    // A failed statement's error line is expected output here — keep the run quiet.
    jest.spyOn((driver as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    statics.SPANNER_DB = undefined;
    statics.LIVENESS_MONITOR = undefined;
    jest.restoreAllMocks();
  });

  /** One statement through a public door, on a transaction whose RPC rejects with `rejection`. */
  const doors: { [door: string]: (rejection: Error, params: { [param: string]: unknown }) => Promise<unknown> } = {
    runDml: (rejection, params) =>
      driver.runDml(
        () => ({ sql: 'UPDATE `ledger` SET `note` = @value WHERE `id` = @id', namedParams: { params, types: {} } }),
        {
          batchUpdate: () => Promise.reject(rejection),
        } as any
      ),
    runQuery: (rejection, params) =>
      driver.runQuery(
        () => ({ sql: 'SELECT `id` FROM `ledger` WHERE `note` = @value', namedParams: { params, types: {} } }),
        {
          run: () => Promise.reject(rejection),
        } as any
      ),
  };

  const RETRIED: [string, number, string, string][] = [
    [
      'a reset stream (EOS on DATA frame)',
      13,
      '13 INTERNAL: Received unexpected EOS on DATA frame from server',
      'retryable stream reset',
    ],
    [
      'a reset stream (RST_STREAM)',
      13,
      '13 INTERNAL: Received RST_STREAM with code 2 (Internal server error)',
      'retryable stream reset',
    ],
    ['a reset stream (HTTP/2)', 13, '13 INTERNAL: HTTP/2 error code: INTERNAL_ERROR', 'retryable stream reset'],
    [
      'a reset stream (connection closed)',
      13,
      '13 INTERNAL: Connection closed with unknown cause',
      'retryable stream reset',
    ],
    [
      'a lost session',
      5,
      '5 NOT_FOUND: Session not found: projects/p/instances/i/databases/d/sessions/s-2',
      'session not found',
    ],
    [
      // The vendor's test is its literal ANYWHERE in the message — no other class the text fits may shadow it.
      'a lost session whose message also fits another class',
      5,
      '5 NOT_FOUND: Table not found: ledger. Session not found: projects/p/instances/i/databases/d/sessions/s-2',
      'session not found',
    ],
    ['an abort (retried on its code alone)', 10, '10 ABORTED: Transaction was aborted.', 'unclassified'],
  ];

  /** How the backend prints a value it echoes as a KEY: quoted, braced, bracketed — never bare. */
  const ECHOED: [string, number, string, (value: string) => string][] = [
    [
      'braced and quoted (an interleaved child insert with no parent row)',
      5,
      'Session not found',
      (value) =>
        `5 NOT_FOUND: Insert failed because key was not found in parent table:  Parent Table: parent  Child Table: child  Key: {String("${value}")}`,
    ],
    [
      'bracketed (a row key)',
      5,
      'Session not found',
      (value) => `5 NOT_FOUND: Row [${value}] in table ledger is missing. Row cannot be updated.`,
    ],
    ['single-quoted', 5, 'Session not found', (value) => `5 NOT_FOUND: No row for key '${value}'`],
    ['double-quoted', 13, 'RST_STREAM', (value) => `13 INTERNAL: Unexpected value "${value}"`],
    [
      'braced',
      13,
      'HTTP/2 error code: INTERNAL_ERROR',
      (value) => `13 INTERNAL: Unexpected key {${value}} while reading`,
    ],
    [
      'bracketed, among other keys',
      13,
      'Connection closed with unknown cause',
      (value) => `13 INTERNAL: Unexpected keys [a, ${value}, b]`,
    ],
    [
      'past the bounded line the runner was shown',
      5,
      'Session not found',
      (value) => `5 NOT_FOUND: ${'no such row; '.repeat(30)}${value}`,
    ],
  ];

  /** The other direction: text outside any quoted, braced or bracketed span was always shown to the runner. */
  const SHOWN: [string, number, string, string][] = [
    ['bare, after other text', 5, 'Session not found', '5 NOT_FOUND: The operation failed: Session not found'],
    ['parenthesized', 13, 'RST_STREAM', '13 INTERNAL: stream closed (RST_STREAM)'],
    [
      'broken across whitespace the line collapses',
      5,
      'Session not found',
      '5 NOT_FOUND: Session\n   not found: projects/p/instances/i/databases/d/sessions/s-2',
    ],
    ['beside a quoted span', 13, 'RST_STREAM', '13 INTERNAL: "frame" Received RST_STREAM with code 2'],
  ];

  describe.each(Object.keys(doors))('%s', (door) => {
    test.each(RETRIED)('%s is retried whatever is bound', async (_name, code, message, failureClass) => {
      const verdicts: object[] = [];
      const expected: object[] = [];
      for (const params of BOUND_SETS) {
        const raw = vendor(code, message);
        const thrown = (await settle(doors[door](raw, params))) as SpannerOperationError;
        const bound = JSON.stringify(Object.values(params));
        verdicts.push({
          bound,
          typed: thrown instanceof SpannerOperationError,
          failureClass: thrown.failureClass,
          code: thrown.code,
          retried: shouldRetry(thrown),
          resetStream: isRetryableInternalError(thrown as any),
          lostSession: isSessionNotFoundError(thrown as any),
        });
        // The premise rides along: the vendor's own error is one the runner retries.
        expected.push({
          bound,
          typed: true,
          failureClass,
          code,
          retried: shouldRetry(raw),
          resetStream: isRetryableInternalError(raw as any),
          lostSession: isSessionNotFoundError(raw as any),
        });
        expect(shouldRetry(raw)).toBe(true);
      }
      expect(verdicts).toEqual(expected);
    });

    test('a failure the runner does not retry stays unretried — a bound value that IS a literal adds no retry', async () => {
      for (const [code, message] of [
        [13, '13 INTERNAL: the backend gave up'],
        [5, '5 NOT_FOUND: Table not found: ledger'],
        [9, '9 FAILED_PRECONDITION: a precondition failed'],
      ] as [number, string][]) {
        for (const params of BOUND_SETS) {
          const raw = vendor(code, message);
          const thrown = await settle(doors[door](raw, params));
          expect(thrown).toBeInstanceOf(SpannerOperationError);
          expect(shouldRetry(raw)).toBe(false);
          expect(shouldRetry(thrown)).toBe(false);
        }
      }
    });

    test.each(ECHOED)(
      'a bound value that IS a literal, echoed by the backend %s: a final failure — never a retry',
      async (_form, code, literal, echo) => {
        const raw = vendor(code, echo(literal));
        const thrown = (await settle(doors[door](raw, { value: literal }))) as SpannerOperationError;

        // The premise: read off the raw message, the vendor's own predicates WOULD re-run this.
        expect(shouldRetry(raw) || isSessionNotFoundError(raw as any)).toBe(true);
        expect(thrown).toBeInstanceOf(SpannerOperationError);
        expect({
          code: thrown.code,
          retried: shouldRetry(thrown),
          lostSession: isSessionNotFoundError(thrown as any),
          literalInMessage: thrown.message.includes(literal),
          failureClass: thrown.failureClass,
        }).toEqual({ code, retried: false, lostSession: false, literalInMessage: false, failureClass: 'unclassified' });
      }
    );

    test.each(SHOWN)(
      'a literal the runner was always shown — %s — is still a retry signal (never fewer)',
      async (_form, code, literal, message) => {
        const raw = vendor(code, message);
        const thrown = (await settle(doors[door](raw, { value: literal }))) as SpannerOperationError;

        expect(thrown).toBeInstanceOf(SpannerOperationError);
        expect(shouldRetry(thrown) || isSessionNotFoundError(thrown as any)).toBe(true);
        expect(thrown.message).toContain(literal);
      }
    );
  });

  test('the backend`s retry delay rides the thrown error structurally (the one metadata entry the runner reads)', async () => {
    const trailers = new grpc.Metadata();
    trailers.set('google.rpc.retryinfo-bin', Buffer.from([10, 2, 8, 1])); // RetryInfo { retry_delay: 1s }
    const raw = vendor(10, '10 ABORTED: Transaction was aborted.', { metadata: trailers });
    const thrown = (await settle(doors.runDml(raw, { value: 2 }))) as SpannerOperationError;
    const delayOf = (error: unknown) =>
      (Runner.prototype as unknown as { getNextDelay(error: unknown): number }).getNextDelay.call(
        { attempts: 1 },
        error
      );

    expect(delayOf(thrown)).toBe(1000);
    expect(delayOf(raw)).toBe(1000);
  });
});

describe('on the emulator: a transaction whose first attempt meets a retry signal is retried and commits, whatever is bound — and a final failure is never re-run', () => {
  const spannerConfig = { projectId: 'proteinjs-test', instanceName: 'proteinjs-test', databaseName: 'test' };
  const spannerDriver = new SpannerDriver(spannerConfig, () => undefined as any);
  const TABLE = 'db_test_retry_signal';
  const PARENT = 'db_test_retry_signal_parent';
  const CHILD = 'db_test_retry_signal_child';
  const quietly = async <T>(work: () => Promise<T>): Promise<T> => {
    const quiet = jest
      .spyOn((spannerDriver as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => {});
    try {
      return await work();
    } finally {
      quiet.mockRestore();
    }
  };

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await spannerDriver.createDbIfNotExists();
    for (const table of [CHILD, PARENT, TABLE]) {
      await quietly(() => spannerDriver.runUpdateSchema(`DROP TABLE ${table}`).catch(() => undefined));
    }
    await spannerDriver.runUpdateSchema([
      `CREATE TABLE ${TABLE} (id STRING(MAX) NOT NULL, n INT64, note STRING(MAX)) PRIMARY KEY (id)`,
      `CREATE TABLE ${PARENT} (pid STRING(MAX) NOT NULL) PRIMARY KEY (pid)`,
      `CREATE TABLE ${CHILD} (pid STRING(MAX) NOT NULL, cid STRING(MAX) NOT NULL) PRIMARY KEY (pid, cid), INTERLEAVE IN PARENT ${PARENT} ON DELETE CASCADE`,
    ]);
  }, 120000);

  afterAll(async () => {
    for (const table of [CHILD, PARENT, TABLE]) {
      await quietly(() => spannerDriver.runUpdateSchema(`DROP TABLE ${table}`).catch(() => undefined));
    }
    await SpannerEmulatorProvisioner.release();
  }, 120000);

  /**
   * One read-write transaction writing `{ n, note }` under `id`. Its FIRST attempt's statement is
   * rejected with `signal` in place of the RPC (the write never reaches the backend); every later
   * attempt runs against the emulator for real.
   */
  const writeThroughSignal = async (id: string, n: number, note: string, signal: () => Error) => {
    let attempts = 0;
    const outcome = await quietly(() =>
      spannerDriver
        .runTransaction(async (transaction) => {
          attempts += 1;
          if (attempts === 1) {
            (transaction as unknown as { batchUpdate: unknown }).batchUpdate = () => Promise.reject(signal());
          }
          return await spannerDriver.runDml(
            () => ({
              sql: `INSERT INTO \`${TABLE}\` (\`id\`, \`n\`, \`note\`) VALUES (@id, @n, @note)`,
              namedParams: { params: { id, n, note }, types: { id: 'string', n: 'int64', note: 'string' } },
            }),
            transaction
          );
        })
        .then(
          (rowCount) => `committed ${rowCount} row`,
          (error: Error) => `rejected: ${error.message}`
        )
    );
    const rows = await spannerDriver.runQuery(() => ({
      sql: `SELECT \`n\`, \`note\` FROM \`${TABLE}\` WHERE \`id\` = @id`,
      namedParams: { params: { id }, types: { id: 'string' } },
    }));
    return { attempts, outcome, rows };
  };

  // A 1ms retry delay from the "backend", so the runner's backoff does not pace the suite.
  const retryInAMillisecond = () => {
    const trailers = new grpc.Metadata();
    trailers.set('google.rpc.retryinfo-bin', Buffer.from([10, 4, 16, 192, 132, 61])); // RetryInfo { retry_delay: 1_000_000ns }
    return trailers;
  };
  const resetStream = () =>
    vendor(13, '13 INTERNAL: HTTP/2 error code: INTERNAL_ERROR', { metadata: retryInAMillisecond() });
  const lostSession = () =>
    vendor(5, '5 NOT_FOUND: Session not found: projects/p/instances/i/databases/d/sessions/s-2');

  test.each([
    ['n = 7 bound (no overlap with the literal)', 7, 'a note'],
    ['n = 2 bound (the 2 of `HTTP/2`)', 2, 'a note'],
    ['`INTERNAL_ERROR` bound', 7, 'INTERNAL_ERROR'],
  ])(
    'a reset stream, %s: retried, committed, the row written',
    async (name, n, note) => {
      const id = `reset ${name}`;

      expect(await writeThroughSignal(id, n, note, resetStream)).toEqual({
        attempts: 2,
        outcome: 'committed 1 row',
        rows: [{ n, note }],
      });
    },
    60000
  );

  test.each([
    ['nothing overlapping bound', 7, 'a note'],
    ['`found` bound', 7, 'found'],
    ['n = 2 bound (the 2 of the session`s name)', 2, 'Session'],
  ])(
    'a lost session, %s: re-run on a fresh session, committed, the row written',
    async (name, n, note) => {
      const id = `session ${name}`;

      expect(await writeThroughSignal(id, n, note, lostSession)).toEqual({
        attempts: 2,
        outcome: 'committed 1 row',
        rows: [{ n, note }],
      });
    },
    60000
  );

  /**
   * The REAL echo. An interleaved child row whose parent does not exist: the backend answers
   * NOT_FOUND and prints the key — `Key: {String("<pid>")}`. With the key bound as the very
   * literal the client library re-runs on, reading that literal off the raw message made a final
   * failure a "lost session", and `runTransactionAsync` re-ran the body on a fresh session without
   * end — the library bounds that loop by nothing. So the body carries its own BRAKE (an attempt
   * cap and a deadline): past either it throws an error no runner retries.
   */
  test.each([
    ['an ordinary key', 'an ordinary key'],
    ['a key that reads `Session not found`', 'Session not found'],
  ])(
    'an interleaved child insert with no parent row, %s: rejected on its first attempt',
    async (_name, pid) => {
      const MAX_ATTEMPTS = 3;
      const deadline = Date.now() + 10_000;
      const backendSaid: string[] = [];
      let attempts = 0;
      const outcome = await quietly(() =>
        spannerDriver
          .runTransaction(async (transaction) => {
            attempts += 1;
            if (attempts > MAX_ATTEMPTS || Date.now() > deadline) {
              throw new Error(`BRAKE: attempt ${attempts} of a transaction that must run once`);
            }
            // The premise is read where the backend's answer arrives, before the driver words it.
            const handle = transaction as unknown as { batchUpdate: (...args: unknown[]) => Promise<unknown> };
            const batchUpdate = handle.batchUpdate.bind(transaction);
            handle.batchUpdate = (...args: unknown[]) =>
              batchUpdate(...args).catch((raw: Error) => {
                backendSaid.push(raw.message);
                throw raw;
              });
            return await spannerDriver.runDml(
              () => ({
                sql: `INSERT INTO \`${CHILD}\` (\`pid\`, \`cid\`) VALUES (@pid, @cid)`,
                namedParams: { params: { pid, cid: 'c1' }, types: { pid: 'string', cid: 'string' } },
              }),
              transaction
            );
          })
          .then(
            () => ({ committed: true }),
            (error: SpannerOperationError) => ({
              committed: false,
              typed: error instanceof SpannerOperationError,
              code: error.code,
              failureClass: error.failureClass,
              lostSession: isSessionNotFoundError(error as any),
              echoesTheKey: error.message.includes(pid),
            })
          )
      );

      expect({ attempts, outcome }).toEqual({
        attempts: 1,
        outcome: {
          committed: false,
          typed: true,
          code: 5,
          failureClass: 'unclassified',
          lostSession: false,
          echoesTheKey: false,
        },
      });
      // The premise: the backend did answer — once — with the key echoed inside braces and quotes.
      expect(backendSaid).toHaveLength(1);
      expect(backendSaid[0]).toContain(`{String("${pid}")}`);
    },
    60000
  );
});
