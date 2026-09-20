import { EventEmitter } from 'events';
import { Database, Spanner } from '@google-cloud/spanner';
import { isSessionNotFoundError } from '@google-cloud/spanner/build/src/session-pool';
import { isRetryableInternalError } from '@google-cloud/spanner/build/src/transaction-runner';
import { grpc } from 'google-gax';
import {
  SpannerDriver,
  SpannerFailureText,
  SpannerLivenessMonitor,
  SpannerOperationError,
} from '@proteinjs/db-driver-spanner';
import { Logger } from '@proteinjs/logger';
import { CapturedLog, lineOf, printed } from './util/printedLine';

/**
 * The backend's own message never reaches a log line or an error the driver throws. It echoes the
 * value it choked on, and not always in a form a mask can find: a bind that does not parse arrives
 * BARE (`Could not parse <value> as a TIMESTAMP`, `Bad int64 value: <value>`), `ERROR(@p)` makes
 * the whole message the value, an index backfill prints the duplicate ROW value, an abort names
 * the key range it conflicted on. Before this contract the driver masked quoted, braced and
 * bracketed text and long numbers out of that message and printed the rest — so every bare echo
 * rode the error-level line, the thrown error's message and its stack.
 *
 * The contract: one owner (`SpannerFailureText`) RECOGNIZES a failure as one of a closed set of
 * classes and the line carries the driver's sentence for it, beside the gRPC code and status; the
 * only vendor text a sentence keeps is a schema identifier (or a number the backend computed) read
 * from a fixed position before any value, never under OUT_OF_RANGE, and never a bound value. The
 * raw vendor error rides the typed error's `vendorError` accessor — not `cause`, not a property a
 * printer can reach.
 *
 * Pure unit tests: no emulator (BackendMessageNeverPrinted.test.ts holds the same contract against
 * the emulator's real messages).
 */

// Fixture values shaped like the row content that must never be printed (none is a real credential).
const VALUE = 'rst_5d41402abc4b2a76b9719d911017c592';
const shape = { operation: 'INSERT', table: 'credential' };
const vendor = (code: number | undefined, message: string, extra?: object) =>
  Object.assign(new Error(message), code === undefined ? {} : { code, details: message }, extra);

type OwnerInternals = { strikeBoundValues: (text: string, boundValues?: { [param: string]: unknown }) => string };
const ownerInternals = SpannerFailureText as unknown as OwnerInternals;

describe('every class of backend message: the driver`s sentence, never the echoed value', () => {
  const cases: [string, number | undefined, string, string, string[]][] = [
    [
      'a string bound to a TIMESTAMP parameter, echoed bare',
      9,
      `Could not parse ${VALUE} as a TIMESTAMP. The timestamp value must end with an uppercase literal 'Z' to specify Zulu time (UTC-0).`,
      'bound value does not parse',
      [],
    ],
    ['an int64 bind, echoed bare', 9, `Could not parse ${VALUE} as an integer`, 'bound value does not parse', []],
    [
      'a float64 bind, echoed bare',
      9,
      `9 FAILED_PRECONDITION: Could not parse ${VALUE} as a FLOAT64. Only the following string values are supported`,
      'bound value does not parse',
      [],
    ],
    [
      'a date bind, echoed bare',
      9,
      `Could not parse ${VALUE} as a DATE. Dates must be in the format YYYY-[M]M-[D]D`,
      'bound value does not parse',
      [],
    ],
    [
      'a numeric bind, echoed bare',
      9,
      `Could not parse ${VALUE} as a NUMERIC. The NUMERIC type supports 38 digits`,
      'bound value does not parse',
      [],
    ],
    ['a CAST failure, echoed bare', 11, `11 OUT_OF_RANGE: Bad int64 value: ${VALUE}`, 'unclassified', []],
    ['a NUMERIC cast failure, echoed bare', 11, `11 OUT_OF_RANGE: Invalid NUMERIC value: ${VALUE}`, 'unclassified', []],
    ['ERROR(@p): the whole message is the value', 11, `11 OUT_OF_RANGE: ${VALUE}`, 'unclassified', []],
    [
      'a JSON number the exact-mode parser refuses',
      11,
      `11 OUT_OF_RANGE: Invalid input to PARSE_JSON: Input number: ${VALUE} cannot round-trip through string representation`,
      'json number does not round-trip',
      ['cannot round-trip through string representation'],
    ],
    [
      'a duplicate primary key, quoted and braced',
      6,
      `Failed to insert row with primary key ({pk#id:"${VALUE}"}) due to previously existing row`,
      'row already exists',
      [],
    ],
    [
      'a duplicate primary key, the hosted phrasing',
      6,
      `Row [${VALUE}] in table credential already exists`,
      'row already exists',
      [],
    ],
    [
      'a unique index violation',
      6,
      `UNIQUE violation on index credential_email,  duplicate key: {String("${VALUE}")} in this transaction.`,
      'unique index violation',
      ['credential_email'],
    ],
    [
      'a unique index violation, the hosted phrasing',
      6,
      `Unique index violation on index credential_email at index key [${VALUE}]. It conflicts with row [${VALUE}] in table credential.`,
      'unique index violation',
      ['credential_email'],
    ],
    [
      'a unique-index backfill over duplicate rows (a schema update)',
      9,
      `Found uniqueness violation on index credential_email,  duplicate key: {String("${VALUE}")}`,
      'unique index backfill found duplicates',
      ['credential_email', 'uniqueness violation'],
    ],
    [
      'a foreign key violation',
      9,
      `Foreign key \`fk_owner\` constraint violation on table \`credential\`. Cannot find referenced key \`{String("${VALUE}")}\` in table \`owner\`.`,
      'foreign key violation',
      ['fk_owner', 'credential'],
    ],
    [
      'a check constraint violation (OUT_OF_RANGE: nothing kept)',
      11,
      `Check constraint \`credential\`.\`ck_email\` is violated for key {String("${VALUE}")}`,
      'check constraint violation',
      [],
    ],
    [
      'an abort naming the key range it conflicted on',
      10,
      `Transaction was aborted. It was wounded by a higher priority transaction due to conflict on keys in range [[${VALUE}], [${VALUE}]), column token in table credential.`,
      'unclassified',
      [],
    ],
    ['a client-side codec rejection with no code', undefined, `Integer ${VALUE} is out of bounds.`, 'unclassified', []],
  ];

  test.each(cases)('%s', (_name, code, message, failureClass, kept) => {
    const vendorError = vendor(code, message);

    // Twice: with the statement's bound values known, and with none (a schema update has none) —
    // the allow-list alone must hold.
    for (const boundValues of [{ token: VALUE }, undefined]) {
      const failure = new SpannerOperationError('dml', shape, vendorError, undefined, boundValues);

      expect(printed(failure)).not.toContain(VALUE);
      expect(JSON.stringify(failure.causeSummary())).not.toContain(VALUE);
      expect(failure.failureClass).toBe(failureClass);
      expect(failure.causeSummary().failureClass).toBe(failureClass);
      for (const token of kept) {
        expect(failure.message).toContain(token);
      }
      if (code !== undefined) {
        expect(failure.code).toBe(code);
        expect(failure.message).toContain(`code ${code}`);
      }
      // The vendor error rides for a caller that asks for it by name — and only there.
      expect(failure.vendorError).toBe(vendorError);
      expect('cause' in failure).toBe(false);
      expect(Object.getOwnPropertyNames(failure)).not.toContain('vendorError');
    }
  });

  test('statement classes keep the SQL`s own identifier and position; a value-size failure keeps the column and the computed numbers', () => {
    const summarize = (code: number, message: string) => SpannerFailureText.summarize(vendor(code, message));

    expect(
      summarize(3, '3 INVALID_ARGUMENT: Unrecognized name: no_such [at 1:35]\nSELECT id FROM t WHERE no_such = @p')
    ).toEqual({
      code: 3,
      status: 'INVALID_ARGUMENT',
      failureClass: 'unrecognized name',
      message: 'the statement names something the schema does not have (no_such at 1:35)',
    });
    expect(summarize(3, '3 INVALID_ARGUMENT: Table not found: no_such_table [at 1:16]').message).toBe(
      'the statement names a table the schema does not have (no_such_table at 1:16)'
    );
    expect(
      summarize(9, 'New value exceeds the maximum size limit for this column: credential.email, size: 103, limit: 64.')
        .message
    ).toBe("a value exceeds its column's size limit (column credential.email, size 103, limit 64)");
    expect(summarize(9, 'Cannot specify a null value for column: credential.owner in table: credential').message).toBe(
      'a NOT NULL column was given no value (column credential.owner)'
    );
    expect(
      summarize(
        3,
        "3 INVALID_ARGUMENT: Index credential_bad specifies key column no_such_column which does not exist in the index's base table."
      ).message
    ).toBe('an index names a key column its table does not have (index credential_bad, column no_such_column)');
    expect(summarize(9, '9 FAILED_PRECONDITION: Duplicate name in schema: credential.')).toEqual({
      code: 9,
      status: 'FAILED_PRECONDITION',
      failureClass: SpannerFailureText.SCHEMA_OBJECT_ALREADY_EXISTS,
      message: 'the schema object already exists (credential)',
    });
  });

  test('anything else carries the sentence for its code, or says its message is withheld', () => {
    expect(SpannerFailureText.summarize(vendor(14, `14 UNAVAILABLE: ${VALUE}`))).toEqual({
      code: 14,
      status: 'UNAVAILABLE',
      failureClass: 'unclassified',
      message: 'the backend is unavailable',
    });
    for (const failure of [new Error(`boom ${VALUE}`), `boom ${VALUE}`, { message: `boom ${VALUE}` }, undefined]) {
      const summary = SpannerFailureText.summarize(failure);
      expect(summary.failureClass).toBe('unclassified');
      expect(summary.message).toMatch(/its message is withheld/);
      expect(JSON.stringify(summary)).not.toContain(VALUE);
    }
  });
});

describe('what a sentence keeps can never be a value', () => {
  test('a bound value in an identifier position is struck before anything is recognized', () => {
    const spoof = vendor(6, `UNIQUE violation on index ${VALUE},  duplicate key: {String("x")} in this transaction.`);

    // The premise: with the value NOT known as bound, the token in that position is kept.
    expect(SpannerFailureText.summarize(spoof).message).toContain(VALUE);
    // Known as bound, it is struck — and the failure falls back to the sentence for its code.
    const summary = SpannerFailureText.summarize(spoof, { token: VALUE });
    expect(JSON.stringify(summary)).not.toContain(VALUE);
    expect(summary).toEqual({
      code: 6,
      status: 'ALREADY_EXISTS',
      failureClass: 'unclassified',
      message: 'the row or object already exists',
    });
  });

  test('an echo the backend cut short is struck like a whole one', () => {
    const cut = `${VALUE.slice(0, 20)}...`;
    const spoof = vendor(6, `UNIQUE violation on index ${cut},  duplicate key: {String("x")} in this transaction.`);

    // The premise: not known as bound, the cut token is kept.
    expect(SpannerFailureText.summarize(spoof).message).toContain(VALUE.slice(0, 20));
    expect(JSON.stringify(SpannerFailureText.summarize(spoof, { token: VALUE }))).not.toContain(VALUE.slice(0, 8));
    expect(ownerInternals.strikeBoundValues(`Bad int64 value: ${cut}`, { token: VALUE })).not.toContain(
      VALUE.slice(0, 8)
    );
  });

  test('under OUT_OF_RANGE — the code ERROR() raises, where the whole message can be data — nothing is kept, bound or not', () => {
    for (const message of [
      `11 OUT_OF_RANGE: UNIQUE violation on index ${VALUE},  duplicate key: {String("x")}`,
      `11 OUT_OF_RANGE: Table not found: ${VALUE}`,
      `11 OUT_OF_RANGE: Cannot specify a null value for column: ${VALUE} in table: t`,
      `11 OUT_OF_RANGE: Duplicate name in schema: ${VALUE}.`,
    ]) {
      const summary = SpannerFailureText.summarize(vendor(11, message));
      expect(JSON.stringify(summary)).not.toContain(VALUE);
      expect(summary.failureClass).toBe('unclassified');
    }
  });

  test('a kept token is read from the START of the message: a class phrase later in the text keeps nothing', () => {
    const summary = SpannerFailureText.summarize(
      vendor(9, `Could not parse x as a DATE. Cannot specify a null value for column: ${VALUE} in table: t`)
    );

    expect(summary.failureClass).toBe('bound value does not parse');
    expect(JSON.stringify(summary)).not.toContain(VALUE);
  });

  test('every form the backend echoes a bound value in is struck: strings, numbers, dates, bytes, wrapped and JSON values, array elements', () => {
    const when = new Date('2026-01-02T03:04:05.678Z');
    const bytes = Buffer.from(VALUE);
    const boundValues = {
      token: VALUE,
      ratio: 0.25,
      wrapped: Spanner.float(7.125),
      big: BigInt('9007199254740993'),
      when,
      bytes,
      settings: { theme: 'theme-5d41402a', depth: { pin: 'pin-c4ca4238' } },
      emails: ['casey.rivers@mail.example', 'robin.hale@mail.example'],
      cleared: null,
    };
    const echoed = [
      VALUE,
      '0.25',
      '7.125',
      '9007199254740993',
      when.toISOString(),
      '2026-01-02',
      bytes.toString('base64'),
      'theme-5d41402a',
      'pin-c4ca4238',
      JSON.stringify(boundValues.settings),
      'casey.rivers@mail.example',
      'robin.hale@mail.example',
    ];

    const struck = ownerInternals.strikeBoundValues(`echo ${echoed.join(' | ')} end`, boundValues);

    for (const form of echoed) {
      expect(struck).not.toContain(form);
    }
    expect(struck.startsWith('echo ')).toBe(true);
    expect(struck.endsWith(' end')).toBe(true);
  });

  test('a short bound value is struck only where it stands alone — it never eats the inside of a schema token or a computed number', () => {
    const summary = SpannerFailureText.summarize(
      vendor(9, 'New value exceeds the maximum size limit for this column: credential.email, size: 103, limit: 64.'),
      { attempts: 1, flag: true, initial: 'e', zero: 0 }
    );
    expect(summary.message).toBe(
      "a value exceeds its column's size limit (column credential.email, size 103, limit 64)"
    );

    expect(ownerInternals.strikeBoundValues('Bad int64 value: 7', { n: 7 })).not.toContain('7');
    expect(ownerInternals.strikeBoundValues('size: 173', { n: 7 })).toBe('size: 173');
  });
});

describe('the driver`s own errors keep their text; the vendor`s retry predicates keep working', () => {
  test('a house-authored error is kept verbatim; the same text from anywhere else is withheld', () => {
    const text =
      'Spanner op exceeded its 150ms deadline: spanner query (configure via SpannerConfig.operationDeadlineMs)';

    expect(SpannerFailureText.summarize(SpannerFailureText.houseError(text))).toEqual({
      failureClass: 'driver',
      message: text,
    });
    expect(SpannerFailureText.summarize(new Error(text)).message).toMatch(/its message is withheld/);
  });

  test('the transaction runner reads the thrown error`s message: a reset stream and a lost session still read as retryable', () => {
    for (const literal of [
      'Received unexpected EOS on DATA frame from server',
      'RST_STREAM',
      'HTTP/2 error code: INTERNAL_ERROR',
      'Connection closed with unknown cause',
    ]) {
      const raw = vendor(13, `13 INTERNAL: ${literal} (${VALUE})`);
      const failure = new SpannerOperationError('dml', shape, raw);
      expect(isRetryableInternalError(raw as any)).toBe(true);
      expect(isRetryableInternalError(failure as any)).toBe(true);
      expect(failure.failureClass).toBe('retryable stream reset');
      expect(printed(failure)).not.toContain(VALUE);
    }
    const lost = new SpannerOperationError(
      'dml',
      shape,
      vendor(5, `5 NOT_FOUND: Session not found: sessions/${VALUE}`)
    );
    expect(isSessionNotFoundError(lost as any)).toBe(true);
    expect(printed(lost)).not.toContain(VALUE);
    // Not every INTERNAL / NOT_FOUND is one of them.
    expect(
      isRetryableInternalError(new SpannerOperationError('dml', shape, vendor(13, '13 INTERNAL: other')) as any)
    ).toBe(false);
    expect(
      isSessionNotFoundError(
        new SpannerOperationError('dml', shape, vendor(5, '5 NOT_FOUND: Table not found: t')) as any
      )
    ).toBe(false);
  });

  test('metadata passes on the backend`s retry delay and nothing else of the vendor`s trailers', () => {
    const trailers = new grpc.Metadata();
    trailers.set('google.rpc.retryinfo-bin', Buffer.from([10, 2, 8, 1]));
    trailers.set('grpc-status-details-bin', Buffer.from(`aborted on key ${VALUE}`));
    trailers.set('x-debug', VALUE);
    const failure = new SpannerOperationError('dml', shape, vendor(10, '10 ABORTED: aborted', { metadata: trailers }));

    const passedOn = failure.metadata as grpc.Metadata;
    expect(passedOn.get('google.rpc.retryinfo-bin')).toEqual([Buffer.from([10, 2, 8, 1])]);
    expect(passedOn.get('grpc-status-details-bin')).toEqual([]);
    expect(passedOn.get('x-debug')).toEqual([]);
    // The vendor's own trailers are untouched, and a vendor error with none passes nothing on.
    expect(trailers.get('x-debug')).toEqual([VALUE]);
    expect(new SpannerOperationError('dml', shape, vendor(10, 'aborted')).metadata).toBeUndefined();
    expect(Object.getOwnPropertyNames(failure)).not.toContain('metadata');
    expect(Object.getOwnPropertyNames(failure)).not.toContain('details');
  });
});

describe('the lines and throws outside a statement ride the same owner', () => {
  type DriverStatics = { SPANNER_DB?: unknown; LIVENESS_MONITOR?: unknown };
  const statics = SpannerDriver as unknown as DriverStatics;
  const fakeMonitor = {
    logPoolPressure: () => undefined,
    poolStats: () => ({ size: 0, available: 0, borrowed: 0, pending: 0, totalWaiters: 0 }),
    reportError: () => undefined,
    stop: () => undefined,
  };
  let captured: CapturedLog[] = [];
  const capturingLogger = (name: string) =>
    new Logger({ name, logLevel: 'debug', logWriter: { write: (log: CapturedLog) => captured.push(log) } as any });

  beforeEach(() => {
    captured = [];
  });

  afterEach(() => {
    statics.SPANNER_DB = undefined;
    statics.LIVENESS_MONITOR = undefined;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('a failed statement hands its bound values to the owner: one echoed where a sentence keeps a token is struck', async () => {
    const echoed = vendor(6, `UNIQUE violation on index ${VALUE},  duplicate key: {String("x")} in this transaction.`);
    statics.SPANNER_DB = { run: () => Promise.reject(echoed) };
    statics.LIVENESS_MONITOR = fakeMonitor;
    const driver = new SpannerDriver({ projectId: 'fake', instanceName: 'fake', databaseName: 'fake' });
    (driver as unknown as { logger: Logger }).logger = capturingLogger('SpannerDriver');

    const outcome: any = await driver
      .runQuery(() => ({
        sql: 'SELECT `id` FROM `credential` WHERE `token` = @token',
        namedParams: { params: { token: VALUE }, types: { token: 'string' } },
      }))
      .then(
        () => 'resolved',
        (error: unknown) => error
      );

    expect(outcome).toBeInstanceOf(SpannerOperationError);
    expect(outcome.vendorError).toBe(echoed);
    expect(printed(outcome)).not.toContain(VALUE);
    expect(captured.filter((log) => log.message === 'Failed when executing query')).toHaveLength(1);
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(VALUE);
    }
  });

  test('a failed commit throws the typed error — the abort`s key range stays on vendorError, its code and retry delay ride along', async () => {
    const aborted = vendor(
      10,
      `10 ABORTED: Transaction was aborted. It was wounded due to conflict on keys in range [[${VALUE}], [${VALUE}]), column token in table credential.`
    );
    const transaction = { commit: () => Promise.reject(aborted), rollback: () => Promise.resolve() };
    statics.SPANNER_DB = {
      runTransactionAsync: (_options: unknown, body: (tx: unknown) => Promise<unknown>) => body(transaction),
    };
    statics.LIVENESS_MONITOR = fakeMonitor;
    const driver = new SpannerDriver({ projectId: 'fake', instanceName: 'fake', databaseName: 'fake' });
    (driver as unknown as { logger: Logger }).logger = capturingLogger('SpannerDriver');

    const outcome: any = await driver
      .runTransaction(async () => 'body ran')
      .then(
        () => 'resolved',
        (error: unknown) => error
      );

    expect(outcome).toBeInstanceOf(SpannerOperationError);
    expect(outcome.operation).toBe('commit');
    expect(outcome.code).toBe(10);
    expect(outcome.message).toBe(
      'Failed when executing commit (ABORTED, code 10): the transaction was aborted (a lock conflict with a concurrent transaction)'
    );
    expect(outcome.vendorError).toBe(aborted);
    expect(printed(outcome)).not.toContain(VALUE);
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(VALUE);
    }
  });

  test('a rollback that fails after a failed body: the debug line summarizes the rejection, never quotes it', async () => {
    const rollbackRejection = vendor(
      10,
      `10 ABORTED: Transaction was aborted on keys in range [[${VALUE}], [${VALUE}])`
    );
    const transaction = { commit: () => Promise.resolve(), rollback: () => Promise.reject(rollbackRejection) };
    statics.SPANNER_DB = {
      runTransactionAsync: (_options: unknown, body: (tx: unknown) => Promise<unknown>) => body(transaction),
    };
    statics.LIVENESS_MONITOR = fakeMonitor;
    const driver = new SpannerDriver({ projectId: 'fake', instanceName: 'fake', databaseName: 'fake' });
    (driver as unknown as { logger: Logger }).logger = capturingLogger('SpannerDriver');
    const bodyFailure = new Error('the body gave up');

    const outcome = await driver
      .runTransaction(async () => {
        throw bodyFailure;
      })
      .then(
        () => 'resolved',
        (error: unknown) => error
      );

    // The ORIGINAL error propagates; the rollback's own failure is one summarized debug line.
    expect(outcome).toBe(bodyFailure);
    const rollbackLines = captured.filter((log) => log.message === 'Rollback after transaction error failed');
    expect(rollbackLines).toHaveLength(1);
    expect(rollbackLines[0].obj).toEqual({
      cause: {
        code: 10,
        status: 'ABORTED',
        failureClass: 'unclassified',
        message: 'the transaction was aborted (a lock conflict with a concurrent transaction)',
      },
    });
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(VALUE);
    }
  });

  test('the liveness monitor`s lines: a pool background error and a failed probe are summarized, never quoted', async () => {
    jest.useFakeTimers();
    const database = Object.assign(new EventEmitter(), {
      pool_: { size: 1, available: 1, borrowed: 0, totalPending: 0, totalWaiters: 0 },
    });
    const monitor = new SpannerLivenessMonitor(database as unknown as Database);
    const internals = monitor as unknown as {
      logger: Logger;
      probe(): Promise<void>;
      exit(): void;
      verifyLiveness(): Promise<void>;
    };
    internals.logger = capturingLogger('SpannerLivenessMonitor');
    jest.spyOn(internals, 'exit').mockImplementation(() => undefined);
    jest.spyOn(internals, 'probe').mockRejectedValue(vendor(14, `14 UNAVAILABLE: no route to ${VALUE}`));
    monitor.start();

    database.emit('error', vendor(9, `9 FAILED_PRECONDITION: session holds ${VALUE}`));
    await jest.advanceTimersByTimeAsync(110_000);

    const poolLine = captured.find((log) => /background error/.test(log.message ?? ''));
    expect(poolLine?.obj.cause).toEqual({
      code: 9,
      status: 'FAILED_PRECONDITION',
      failureClass: 'unclassified',
      message: 'a precondition failed (a constraint, a parameter type, or the state of the database)',
    });
    const probeLines = captured.filter((log) => log.message === 'Db connectivity probe failed');
    expect(probeLines).toHaveLength(5);
    expect(probeLines[0].obj.cause).toEqual(expect.objectContaining({ code: 14, status: 'UNAVAILABLE' }));
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(VALUE);
    }
  });
});
