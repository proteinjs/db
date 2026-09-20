import { DeadlineError } from '@google-cloud/spanner/build/src/transaction-runner';
import { inspect } from 'util';
import { SpannerDriver, SpannerOperationError } from '@proteinjs/db-driver-spanner';
import { Logger } from '@proteinjs/logger';
import { CapturedLog, lineOf } from './util/printedLine';

/**
 * Writing a log line can NEVER change what the driver throws — or whether a statement runs. The
 * driver's statement lines are written on the way to an RPC (`Executing query` / `Executing dml`)
 * and on the way to a `throw` (the failure line, the retried-abort line), so anything that goes
 * wrong while building or writing one would surface as the statement's outcome: a caller that
 * matches on the backend's code would stop matching, and the client library — which decides
 * transaction retries off the thrown error — would decide differently.
 *
 * Two layers hold that, and this suite holds both:
 *
 *  - the helpers that build a line's `params` (`describeParams`, `loggedParams`) are TOTAL:
 *    whatever a statement carries — a typed params map, an untyped one, nothing, null, a string,
 *    an array, a Map, an entry whose accessor or `toJSON` throws, a declared type nobody can
 *    print, a proxy that refuses everything — they return a description and never a value;
 *  - every statement line is written through ONE guarded door (`writeStatementLine`): if building
 *    or writing it throws anyway — a log writer that is down, a serializer meeting a value it
 *    cannot print — the failure is reported as one FIXED line that carries nothing of the
 *    statement, and the driver goes on exactly as it was going to.
 *
 * No emulator is needed: the driver's real doors run with the vendor client's call stubbed in
 * place of the RPC, the way LogValuesSwitch.test.ts drives them. The stubbed backend messages
 * quote no bound value (see StatementParamLogging.test.ts's header for that class).
 */

// A fixture value shaped like row content (not a real credential).
const CANARY = 'rst_5d41402abc4b2a76b9719d911017c592';

type ParamDescription = { type: string; length?: number; null?: true };
type ParamsDescription = { [name: string]: ParamDescription } | 'unreadable';
type DriverInternals = {
  logger: Logger;
  describeParams: (namedParams?: unknown) => ParamsDescription | undefined;
  loggedParams: (namedParams?: unknown) => { params?: ParamsDescription; paramValues?: unknown };
};

/** What a throwing accessor throws: one object, so a test can tell it from anything else. */
const ACCESSOR_ERROR = new Error('accessor refused');
const throwingEntry = (target: object, name: string): any =>
  Object.defineProperty(target, name, {
    enumerable: true,
    get: () => {
      throw ACCESSOR_ERROR;
    },
  });
const refusesEverything = (target: object): any =>
  new Proxy(target, {
    get: () => {
      throw ACCESSOR_ERROR;
    },
    has: () => {
      throw ACCESSOR_ERROR;
    },
    ownKeys: () => {
      throw ACCESSOR_ERROR;
    },
    getPrototypeOf: () => {
      throw ACCESSOR_ERROR;
    },
    getOwnPropertyDescriptor: () => {
      throw ACCESSOR_ERROR;
    },
  });
const revoked = (target: object): any => {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
};
/** An array that answers every read — its `length` included — with the value itself. */
const lyingArray = (): any => new Proxy([CANARY], { get: () => CANARY });
const throwingToJson = () => ({
  token: CANARY,
  toJSON: () => {
    throw ACCESSOR_ERROR;
  },
});
const string36 = { type: 'string', length: CANARY.length };
/** A string standing where the params map belongs reads as its characters, by index — lengths only. */
const characterByCharacter = CANARY.split('').reduce<{ [name: string]: ParamDescription }>((described, _, index) => {
  described[index] = { type: 'string', length: 1 };
  return described;
}, {});

/** The description is not pinned for this shape — only that there is one, and that it carries no value. */
const UNPINNED = Symbol('unpinned');

/** Every shape a statement can carry as its named params, and the description each one gets. */
const STATEMENTS: [string, () => unknown, ParamsDescription | undefined | typeof UNPINNED][] = [
  [
    'a typed statement',
    () => ({
      params: { token: CANARY, emails: [CANARY, CANARY] },
      types: { token: 'string', emails: { type: 'array', child: { type: 'string' } } },
    }),
    { token: string36, emails: { type: 'array<string>', length: 2 } },
  ],
  [
    'an untyped statement — each value by its kind',
    () => ({ params: { token: CANARY, n: 3, at: new Date(0), raw: Buffer.from(CANARY), none: null } }),
    {
      token: string36,
      n: { type: 'number' },
      at: { type: 'date' },
      raw: { type: 'bytes', length: Buffer.from(CANARY).length },
      none: { type: 'null', null: true },
    },
  ],
  ['nothing', () => undefined, undefined],
  ['null', () => null, undefined],
  ['a statement with no params', () => ({}), undefined],
  ['null for the params map', () => ({ params: null, types: { token: 'string' } }), undefined],
  ['a string for the statement', () => CANARY, undefined],
  ['a number for the statement', () => 7, undefined],
  ['an array for the statement', () => [CANARY], undefined],
  ['a string for the params map', () => ({ params: CANARY }), characterByCharacter],
  ['an array for the params map', () => ({ params: [CANARY, 3] }), { 0: string36, 1: { type: 'number' } }],
  ['a Map for the params map — it has no entries to name', () => ({ params: new Map([['token', CANARY]]) }), {}],
  ['null for the types map', () => ({ params: { token: CANARY }, types: null }), { token: string36 }],
  ['a string for the types map', () => ({ params: { token: CANARY }, types: CANARY }), { token: string36 }],
  ['a number for a declared type', () => ({ params: { token: CANARY }, types: { token: 5 } }), UNPINNED],
  [
    'an array type with no child',
    () => ({ params: { emails: [CANARY] }, types: { emails: { type: 'array' } } }),
    { emails: { type: 'array<unknown>', length: 1 } },
  ],
  [
    'a declared type nobody can print (a symbol)',
    () => ({ params: { id: CANARY, token: CANARY }, types: { id: 'string', token: { type: Symbol(CANARY) } } }),
    { id: string36, token: { type: 'unreadable' } },
  ],
  [
    'a declared type whose accessor throws',
    () => ({ params: { id: CANARY, token: CANARY }, types: throwingEntry({ id: 'string' }, 'token') }),
    { id: string36, token: { type: 'unreadable' } },
  ],
  [
    'an entry whose accessor throws',
    () => ({ params: throwingEntry({ id: CANARY }, 'token') }),
    { id: string36, token: { type: 'unreadable' } },
  ],
  ['a value whose toJSON throws', () => ({ params: { token: throwingToJson() } }), { token: { type: 'object' } }],
  [
    'a value that refuses every read',
    () => ({ params: { token: refusesEverything({ token: CANARY }) } }),
    { token: { type: 'unreadable' } },
  ],
  [
    'an array that answers every read with the value',
    () => ({ params: { emails: lyingArray() } }),
    { emails: { type: 'array' } },
  ],
  [
    'a bigint, a symbol, a function',
    () => ({ params: { a: BigInt(7), b: Symbol(CANARY), c: () => CANARY } }),
    UNPINNED,
  ],
  ['a params map that refuses every read', () => ({ params: refusesEverything({ token: CANARY }) }), 'unreadable'],
  ['a revoked params map', () => ({ params: revoked({ token: CANARY }) }), 'unreadable'],
  ['a statement that refuses every read', () => refusesEverything({ params: { token: CANARY } }), 'unreadable'],
  ['a revoked statement', () => revoked({ params: { token: CANARY } }), 'unreadable'],
];

describe('describeParams and loggedParams are total: any statement, a description, never a value', () => {
  const internals = new SpannerDriver({
    projectId: 'fake',
    instanceName: 'fake',
    databaseName: 'fake',
  }) as unknown as DriverInternals;
  const ENV = ['DEVELOPMENT', 'DB_LOG_PARAM_VALUES'];
  const envBefore: { [name: string]: string | undefined } = {};

  beforeEach(() => {
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
  });

  test.each(STATEMENTS)('%s', (_shape, namedParams, expected) => {
    let described: ParamsDescription | undefined;
    let logged: { params?: ParamsDescription; paramValues?: unknown } = {};

    expect(() => {
      described = internals.describeParams(namedParams());
      logged = internals.loggedParams(namedParams());
    }).not.toThrow();

    if (expected !== UNPINNED) {
      expect(described).toEqual(expected);
    }
    // What the lines carry is the description, and nothing else while the values switch is closed.
    expect(logged).toEqual({ params: described });
    expect(inspect(logged, { depth: 10, showHidden: true })).not.toContain(CANARY);
    expect(JSON.stringify(logged) ?? '').not.toContain(CANARY);
  });

  test.each(STATEMENTS)(
    'the values switch open — %s: still no throw, and the description is the same',
    (_shape, namedParams) => {
      const closed = internals.loggedParams(namedParams());
      Object.assign(process.env, { DEVELOPMENT: 'true', DB_LOG_PARAM_VALUES: '1' });
      let open: { params?: ParamsDescription; paramValues?: unknown } = {};

      expect(() => {
        open = internals.loggedParams(namedParams());
      }).not.toThrow();

      expect(open.params).toEqual(closed.params);
    }
  );
});

const vendor = (code: number, message: string) => Object.assign(new Error(message), { code, details: message });
const settle = <T>(run: () => Promise<T>): Promise<any> =>
  Promise.resolve()
    .then(run)
    .catch((error: unknown) => error);

describe('writing a statement line never changes what the driver throws, or whether the statement runs', () => {
  type DriverStatics = { SPANNER_DB?: unknown; LIVENESS_MONITOR?: unknown; CONSECUTIVE_DEADLINE_FAILURES: number };
  const statics = SpannerDriver as unknown as DriverStatics;
  const reported: unknown[] = [];
  const fakeMonitor = {
    logPoolPressure: () => undefined,
    poolStats: () => ({ size: 0, available: 0, borrowed: 0, pending: 0, totalWaiters: 0 }),
    reportError: (error: unknown) => reported.push(error),
    stop: () => undefined,
  };
  let written: CapturedLog[] = [];

  /** A driver whose log writer records every line it is handed and then throws for the ones `refuses` names. */
  const driverWhoseWriterThrows = (refuses: (log: CapturedLog) => boolean): SpannerDriver => {
    statics.LIVENESS_MONITOR = fakeMonitor;
    const driver = new SpannerDriver({ projectId: 'fake', instanceName: 'fake', databaseName: 'fake' });
    (driver as unknown as DriverInternals).logger = new Logger({
      name: 'SpannerDriver',
      logLevel: 'debug',
      logWriter: {
        write: (log: CapturedLog) => {
          written.push(log);
          if (refuses(log)) {
            throw new Error('the log writer is down');
          }
        },
      } as any,
    });
    return driver;
  };
  const STATEMENT_LINES = [
    'Executing dml',
    'Executing query',
    'Failed when executing dml',
    'Failed when executing query',
    'Transaction aborted at dml; the transaction runner retries it',
  ];
  const onStatementLines = (log: CapturedLog) => STATEMENT_LINES.includes(log.message ?? '');
  const FIXED_LINE = 'Failed to write a statement log line';

  beforeEach(() => {
    written = [];
    reported.length = 0;
  });

  afterEach(() => {
    statics.SPANNER_DB = undefined;
    statics.LIVENESS_MONITOR = undefined;
    statics.CONSECUTIVE_DEADLINE_FAILURES = 0;
  });

  const namedParams = { params: { id: CANARY, n: 42 }, types: { id: 'string', n: 'int64' } };
  const dml = () => ({ sql: 'INSERT INTO `credential` (`id`, `n`) VALUES (@id, @n)', namedParams });
  const query = () => ({ sql: 'SELECT `n` FROM `credential` WHERE `id` = @id AND `n` = @n', namedParams });
  /** Everything a caller can read off a caught error. */
  const facts = (error: any) => ({
    class: error?.constructor?.name,
    name: error?.name,
    message: error?.message,
    code: error?.code,
    own: Object.getOwnPropertyNames(Object(error))
      .sort()
      .map((name) => [name, name === 'stack' ? '(stack)' : error[name]]),
  });

  test('a failed dml, the writer throwing on every statement line: the throw is the driver`s typed error over the backend`s own, as with a working writer', async () => {
    const tableMissing = vendor(5, '5 NOT_FOUND: Table not found: credential');
    const transaction = { batchUpdate: () => Promise.reject(tableMissing) } as any;
    const baseline = await settle(() => driverWhoseWriterThrows(() => false).runDml(dml, transaction));
    // The premise: a working writer got both lines, and the failure is the typed error over the backend's.
    expect(written.map((log) => log.message)).toEqual(['Executing dml', 'Failed when executing dml']);
    expect(baseline).toBeInstanceOf(SpannerOperationError);
    written = [];
    reported.length = 0;

    const caught = await settle(() => driverWhoseWriterThrows(onStatementLines).runDml(dml, transaction));

    expect(caught).toBeInstanceOf(SpannerOperationError);
    expect(caught.cause).toBe(tableMissing);
    expect(facts(caught)).toEqual(facts(baseline));
    // Each lost line is reported as the one fixed line, which carries nothing of the statement.
    expect(written.map((log) => log.message)).toEqual([
      'Executing dml',
      FIXED_LINE,
      'Failed when executing dml',
      FIXED_LINE,
    ]);
    for (const fixed of written.filter((log) => log.message === FIXED_LINE)) {
      expect(fixed.logLevel).toBe('error');
      expect(fixed.obj).toBeUndefined();
      expect(fixed.error).toBeUndefined();
      expect(lineOf(fixed)).not.toContain(CANARY);
    }
    // And the failure still reaches the liveness monitor, as the backend's own error.
    expect(reported).toEqual([tableMissing]);
  });

  test('a failed query, the writer throwing on EVERY line: the throw is still the typed error over the backend`s own', async () => {
    const tableMissing = vendor(5, '5 NOT_FOUND: Table not found: credential');
    statics.SPANNER_DB = { run: () => Promise.reject(tableMissing) };

    const caught = await settle(() => driverWhoseWriterThrows(() => true).runQuery(query));

    expect(caught).toBeInstanceOf(SpannerOperationError);
    expect(caught.cause).toBe(tableMissing);
    expect(caught.code).toBe(5);
  });

  test('a query that succeeds, the writer throwing on its statement line: the query still runs and returns its rows', async () => {
    let calls = 0;
    statics.SPANNER_DB = {
      run: () => {
        calls += 1;
        return Promise.resolve([[{ toJSON: () => ({ n: 42 }) }]]);
      },
    };

    const rows = await settle(() => driverWhoseWriterThrows(onStatementLines).runQuery(query));

    expect(rows).toEqual([{ n: 42 }]);
    expect(calls).toBe(1);
    expect(written.map((log) => log.message)).toEqual(['Executing query', FIXED_LINE, 'Query executed']);
  });

  test('a retried abort, the writer throwing on its line: the runner still sees the typed ABORTED it retries on', async () => {
    const aborted = vendor(10, '10 ABORTED: Transaction was aborted.');
    const transaction = {
      batchUpdate: () => Promise.reject(aborted),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
    };
    const seenByTheRunner: unknown[] = [];
    statics.SPANNER_DB = {
      runTransactionAsync: (_options: unknown, body: (handle: unknown) => Promise<unknown>) =>
        body(transaction).catch((lastAbort: Error) => {
          seenByTheRunner.push(lastAbort);
          throw new DeadlineError(lastAbort as any);
        }),
    };

    await settle(() => driverWhoseWriterThrows(onStatementLines).runDml(dml));

    expect(seenByTheRunner).toHaveLength(1);
    expect(seenByTheRunner[0]).toBeInstanceOf(SpannerOperationError);
    expect((seenByTheRunner[0] as any).cause).toBe(aborted);
    expect((seenByTheRunner[0] as any).code).toBe(10);
    expect(written.map((log) => log.message)).toContain(
      'Transaction aborted at dml; the transaction runner retries it'
    );
    // A retried abort is never reported as a failure.
    expect(reported).toEqual([]);
  });

  test('the values switch open and a writer that cannot serialize a bound value: the throw is still the typed error over the backend`s own', async () => {
    const envBefore = { DEVELOPMENT: process.env.DEVELOPMENT, DB_LOG_PARAM_VALUES: process.env.DB_LOG_PARAM_VALUES };
    Object.assign(process.env, { DEVELOPMENT: 'true', DB_LOG_PARAM_VALUES: '1' });
    try {
      const tableMissing = vendor(5, '5 NOT_FOUND: Table not found: credential');
      statics.LIVENESS_MONITOR = fakeMonitor;
      const driver = new SpannerDriver({ projectId: 'fake', instanceName: 'fake', databaseName: 'fake' });
      // A structured writer: it serializes what it is handed, and a bigint cannot be serialized.
      (driver as unknown as DriverInternals).logger = new Logger({
        name: 'SpannerDriver',
        logLevel: 'debug',
        logWriter: {
          write: (log: CapturedLog) => {
            written.push({ logLevel: log.logLevel, message: log.message });
            JSON.stringify(log.obj);
          },
        } as any,
      });

      const caught = await settle(() =>
        driver.runDml(
          () => ({
            sql: 'INSERT INTO `credential` (`n`) VALUES (@n)',
            namedParams: { params: { n: BigInt(7) } } as any,
          }),
          { batchUpdate: () => Promise.reject(tableMissing) } as any
        )
      );

      expect(caught).toBeInstanceOf(SpannerOperationError);
      expect(caught.cause).toBe(tableMissing);
      expect(written.map((log) => log.message)).toEqual([
        'Executing dml',
        FIXED_LINE,
        'Failed when executing dml',
        FIXED_LINE,
      ]);
    } finally {
      for (const [name, value] of Object.entries(envBefore)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  /**
   * Statements of every shape, at the door. The vendor call is stubbed to reject with the
   * backend's error whatever it is handed, so the ONLY thing between the statement and the typed
   * error over that rejection is the driver's own handling of the statement — and its lines.
   * (Shapes the driver's bind step itself refuses — it copies the params map, so an accessor that
   * throws there is that step's failure — name the accessor's error as the cause instead.)
   */
  const DOORS: [string, 'the backend`s error' | 'the accessor`s error', () => unknown][] = [
    ['a typed statement', 'the backend`s error', () => namedParams],
    ['an untyped statement', 'the backend`s error', () => ({ params: { id: CANARY } })],
    ['no params at all', 'the backend`s error', () => undefined],
    ['a string for the params map', 'the backend`s error', () => ({ params: CANARY })],
    ['a Map for the params map', 'the backend`s error', () => ({ params: new Map([['id', CANARY]]) })],
    [
      'a declared type nobody can print (a symbol)',
      'the backend`s error',
      () => ({ params: { id: CANARY }, types: { id: { type: Symbol(CANARY) } } }),
    ],
    [
      'an untyped statement with an entry whose accessor throws',
      'the backend`s error',
      () => ({ params: throwingEntry({ id: CANARY }, 'token') }),
    ],
    ['a value whose toJSON throws', 'the backend`s error', () => ({ params: { id: throwingToJson() } })],
    ['an untyped revoked params map', 'the backend`s error', () => ({ params: revoked({ id: CANARY }) })],
    [
      'a typed statement with an entry whose accessor throws (the bind step refuses it)',
      'the accessor`s error',
      () => ({ params: throwingEntry({ id: CANARY }, 'token'), types: { id: 'string' } }),
    ],
    [
      'a statement that refuses every read (the bind step refuses it)',
      'the accessor`s error',
      () => refusesEverything({ params: { id: CANARY } }),
    ],
  ];

  test.each(DOORS)(
    'at the door — %s: the throw is the typed error over %s, and no line carries a value',
    async (_shape, cause, shape) => {
      const tableMissing = vendor(5, '5 NOT_FOUND: Table not found: credential');
      const expectedCause = cause === 'the backend`s error' ? tableMissing : ACCESSOR_ERROR;
      statics.SPANNER_DB = { run: () => Promise.reject(tableMissing) };
      const statement = () => ({ sql: 'SELECT `n` FROM `credential` WHERE `id` = @id', namedParams: shape() as any });

      const fromQuery = await settle(() => driverWhoseWriterThrows(() => false).runQuery(statement));
      const fromDml = await settle(() =>
        driverWhoseWriterThrows(() => false).runDml(statement, {
          batchUpdate: () => Promise.reject(tableMissing),
        } as any)
      );

      for (const caught of [fromQuery, fromDml]) {
        expect(caught).toBeInstanceOf(SpannerOperationError);
        expect(caught.cause).toBe(expectedCause);
      }
      expect(written.map((log) => log.message)).toEqual([
        'Executing query',
        'Failed when executing query',
        'Executing dml',
        'Failed when executing dml',
      ]);
      for (const log of written) {
        expect(lineOf(log)).not.toContain(CANARY);
      }
    }
  );
});
