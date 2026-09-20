import knex from 'knex';
import { inspect } from 'util';
import { KnexDriver } from '@proteinjs/db-driver-knex';
import { Logger } from '@proteinjs/logger';
import { CapturedLog, lineOf } from './util/printedLine';

/**
 * Writing a log line can NEVER change what the driver throws. The failure line is written on the
 * way to `throw error`, so anything that goes wrong while building or writing it would replace the
 * vendor's error with its own — a caller that matches on the vendor's code would stop matching, and
 * the failure line itself would be lost.
 *
 * Two layers hold that, and this suite holds both:
 *
 *  - the helpers that build the line (`describeParams`, `causeSummary`) are TOTAL: whatever they
 *    are handed — positional bindings, a bindings dictionary, nothing, null, a scalar, a Map, a
 *    value whose accessor or `toJSON` throws, a proxy that refuses everything — they return a
 *    description and never a value;
 *  - the line is written through ONE guarded door (`writeStatementLine`): if building or writing it
 *    throws anyway — a log writer that is down, a serializer meeting a value it cannot print — the
 *    failure is reported as one FIXED line that carries nothing of the statement, and the driver
 *    goes on to throw exactly what it was going to throw.
 *
 * No server is needed: the REAL query layer and dialect run over a stub connection that rejects
 * the way the client library does. The stub server's message quotes no bound value (what the
 * SERVER echoes is not this suite's subject; see StatementParamLogging.test.ts's header).
 */

// A fixture value shaped like row content (not a real credential).
const CANARY = 'rst_5d41402abc4b2a76b9719d911017c592';

type ParamDescription = { type: string; length?: number; null?: true };
type ParamsDescription = ParamDescription[] | { [name: string]: ParamDescription } | 'unreadable';
type DriverInternals = {
  logger: Logger;
  describeParams: (params?: unknown) => ParamsDescription | undefined;
  causeSummary: (error: unknown) => { [fact: string]: unknown };
};
type DriverStatics = { KNEX?: unknown };

/** What a throwing accessor throws: one object, so a test can tell it from anything else. */
const ACCESSOR_ERROR = new Error('accessor refused');
const throwingEntry = (target: object, name: string | number): any =>
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
class Credentials {
  token = CANARY;
}

/** Every shape the driver can be handed as a statement's bindings, and the description each one gets. */
const BINDINGS: [string, () => unknown, ParamsDescription | undefined][] = [
  ['positional bindings', () => [CANARY, 3], [{ type: 'string', length: CANARY.length }, { type: 'number' }]],
  [
    'a bindings dictionary',
    () => ({ token: CANARY, n: 3 }),
    { token: { type: 'string', length: 36 }, n: { type: 'number' } },
  ],
  [
    'a dictionary with no prototype',
    () => Object.assign(Object.create(null), { token: CANARY }),
    { token: { type: 'string', length: CANARY.length } },
  ],
  ['nothing', () => undefined, undefined],
  ['null — the query layer binds it as one parameter', () => null, [{ type: 'null', null: true }]],
  ['a scalar string — one parameter', () => CANARY, [{ type: 'string', length: CANARY.length }]],
  ['an empty string', () => '', [{ type: 'string', length: 0 }]],
  ['zero', () => 0, [{ type: 'number' }]],
  ['false', () => false, [{ type: 'boolean' }]],
  ['a bigint', () => BigInt(CANARY.length), [{ type: 'bigint' }]],
  ['a symbol', () => Symbol(CANARY), [{ type: 'symbol' }]],
  ['a function', () => () => CANARY, [{ type: 'function' }]],
  ['a Map — not a dictionary: one parameter', () => new Map([['token', CANARY]]), [{ type: 'object' }]],
  ['a Set', () => new Set([CANARY]), [{ type: 'object' }]],
  ['a class instance — not a dictionary: one parameter', () => new Credentials(), [{ type: 'object' }]],
  ['a Date', () => new Date(0), [{ type: 'date' }]],
  ['bytes', () => Buffer.from(CANARY), [{ type: 'bytes', length: Buffer.from(CANARY).length }]],
  [
    'a dictionary with an entry whose accessor throws',
    () => throwingEntry({ id: CANARY }, 'token'),
    { id: { type: 'string', length: CANARY.length }, token: { type: 'unreadable' } },
  ],
  [
    'positional bindings with a position whose accessor throws',
    () => throwingEntry([CANARY, undefined], 1),
    [{ type: 'string', length: CANARY.length }, { type: 'unreadable' }],
  ],
  [
    'a value whose toJSON throws',
    () => [
      {
        token: CANARY,
        toJSON: () => {
          throw ACCESSOR_ERROR;
        },
      },
    ],
    [{ type: 'object' }],
  ],
  [
    'a positional value that refuses every read',
    () => [refusesEverything({ token: CANARY })],
    [{ type: 'unreadable' }],
  ],
  ['an array that answers every read with the value', () => [lyingArray()], [{ type: 'array' }]],
  ['bindings that refuse every read', () => refusesEverything({ token: CANARY }), 'unreadable'],
  ['revoked bindings', () => revoked([CANARY]), 'unreadable'],
  [
    'a sparse array',
    () => new Array(2),
    [
      { type: 'null', null: true },
      { type: 'null', null: true },
    ],
  ],
];

describe('describeParams is total: any bindings, a description, never a value', () => {
  const internals = new KnexDriver({
    host: 'localhost',
    user: 'root',
    password: '',
    dbName: 'test',
  }) as unknown as DriverInternals;

  test.each(BINDINGS)('%s', (_shape, bindings, expected) => {
    let described: ParamsDescription | undefined;

    expect(() => {
      described = internals.describeParams(bindings());
    }).not.toThrow();

    expect(described).toEqual(expected);
    expect(inspect(described, { depth: 10, showHidden: true })).not.toContain(CANARY);
    expect(JSON.stringify(described) ?? '').not.toContain(CANARY);
  });
});

describe('causeSummary is total: anything thrown, a summary of codes, never the rewritten message', () => {
  const internals = new KnexDriver({
    host: 'localhost',
    user: 'root',
    password: '',
    dbName: 'test',
  }) as unknown as DriverInternals;
  const vendorFacts = {
    code: 'ER_NO_SUCH_TABLE',
    errno: 1146,
    sqlState: '42S02',
    sqlMessage: `Table 't' doesn't exist`,
  };

  const THROWN: [string, () => unknown, { [fact: string]: unknown }][] = [
    [
      'a vendor error whose message and sql carry the bindings',
      () => Object.assign(new Error(`insert ... '${CANARY}'`), vendorFacts, { sql: `insert ... '${CANARY}'` }),
      { name: 'Error', ...vendorFacts },
    ],
    ['nothing', () => undefined, {}],
    ['null', () => null, {}],
    ['a thrown string', () => CANARY, {}],
    ['a thrown number', () => 1146, {}],
    ['facts of the wrong kind', () => ({ name: 5, code: 1146, errno: '1146', sqlState: null, sqlMessage: {} }), {}],
    [
      'an error with a fact whose accessor throws',
      () => throwingEntry(Object.assign(new Error(CANARY), vendorFacts), 'code'),
      { name: 'Error', errno: 1146, sqlState: '42S02', sqlMessage: vendorFacts.sqlMessage },
    ],
    ['an error that refuses every read', () => refusesEverything(new Error(CANARY)), {}],
    ['a revoked error', () => revoked(new Error(CANARY)), {}],
  ];

  test.each(THROWN)('%s', (_shape, thrown, expected) => {
    let summary: { [fact: string]: unknown } | undefined;

    expect(() => {
      summary = internals.causeSummary(thrown());
    }).not.toThrow();

    expect(summary).toEqual(expected);
    expect(inspect(summary, { depth: 10, showHidden: true })).not.toContain(CANARY);
  });
});

/** The errors the stub connection rejected with, as they left the client library's callback. */
const rejected: Error[] = [];

/** A connection that rejects every statement like a missing table — a server message that quotes no binding. */
const rejectingConnection = () => {
  const mysql = require('mysql');
  return {
    state: 'authenticated',
    on: () => undefined,
    removeAllListeners: () => undefined,
    connect: (done: (error?: Error) => void) => done(),
    end: (done: (error?: Error) => void) => done(),
    query: (options: { sql: string }, bindings: any[], done: (error: Error | null, rows?: unknown[]) => void) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(options.sql)) {
        done(null, []);
        return;
      }
      const sqlMessage = `Table 'test.credential' doesn't exist`;
      const error = Object.assign(new Error(`ER_NO_SUCH_TABLE: ${sqlMessage}`), {
        code: 'ER_NO_SUCH_TABLE',
        errno: 1146,
        sqlState: '42S02',
        sqlMessage,
        sql: mysql.format(options.sql, bindings),
      });
      rejected.push(error);
      done(error);
    },
  };
};

const settle = <T>(run: () => Promise<T>): Promise<any> =>
  Promise.resolve()
    .then(run)
    .then(() => 'resolved' as const)
    .catch((error) => error);

describe('writing the failure line never changes what the driver throws', () => {
  const driver = new KnexDriver({ host: 'localhost', user: 'root', password: '', dbName: 'test' });
  const internals = driver as unknown as DriverInternals;
  const statics = KnexDriver as unknown as DriverStatics;
  const ENV = ['DEVELOPMENT', 'DB_LOG_PARAM_VALUES'];
  const envBefore: { [name: string]: string | undefined } = {};
  let written: CapturedLog[] = [];
  let instance: ReturnType<typeof knex>;
  let previousInstance: unknown;

  /** A logger whose writer records every line it is handed and then throws for the ones `refuses` names. */
  const loggerThatThrows = (refuses: (log: CapturedLog) => boolean) =>
    new Logger({
      name: 'KnexDriver',
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

  beforeAll(() => {
    instance = knex({ client: 'mysql', connection: { host: 'localhost', user: 'root', password: '' } });
    (instance as any).client.driver = { createConnection: rejectingConnection };
    previousInstance = statics.KNEX;
    statics.KNEX = instance;
  });

  afterAll(async () => {
    statics.KNEX = previousInstance;
    await instance.destroy();
  });

  beforeEach(() => {
    written = [];
    rejected.length = 0;
    internals.logger = loggerThatThrows(() => false);
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

  const INSERT = 'INSERT INTO `credential` (`id`, `token`) VALUES (?, ?)';
  const insertStatement = () => ({ sql: INSERT, params: ['c0ffee00-0000-4000-8000-000000000001', CANARY] });
  /** Everything a caller can read off a caught error. */
  const facts = (error: any) => ({
    class: error?.constructor?.name,
    message: error?.message,
    own: Object.getOwnPropertyNames(Object(error))
      .sort()
      .map((name) => [name, name === 'stack' ? '(stack)' : error[name]]),
  });

  test('the premise: with a working writer the statement fails with the vendor`s error and writes its one line', async () => {
    const outcome = await settle(() => driver.runDml(insertStatement));

    expect(rejected).toHaveLength(1);
    expect(outcome).toBe(rejected[0]);
    expect(written.map((log) => log.message)).toEqual(['Failed when executing sql']);
  });

  test('a writer that throws on the failure line: the throw is still the vendor`s error itself, and the lost line is reported as one fixed line', async () => {
    internals.logger = loggerThatThrows((log) => log.message === 'Failed when executing sql');

    const outcome = await settle(() => driver.runDml(insertStatement));

    expect(rejected).toHaveLength(1);
    expect(outcome).toBe(rejected[0]);
    expect(outcome.code).toBe('ER_NO_SUCH_TABLE');
    expect(written.map((log) => log.message)).toEqual([
      'Failed when executing sql',
      'Failed to write a statement log line',
    ]);
    // The fixed line carries nothing of the statement: no sql, no params, no error.
    const [, fixed] = written;
    expect(fixed.logLevel).toBe('error');
    expect(fixed.obj).toBeUndefined();
    expect(fixed.error).toBeUndefined();
    expect(lineOf(fixed)).not.toContain(CANARY);
  });

  test('a writer that throws on EVERY line: the throw is still the vendor`s error itself', async () => {
    internals.logger = loggerThatThrows(() => true);

    const outcome = await settle(() => driver.runDml(insertStatement));

    expect(rejected).toHaveLength(1);
    expect(outcome).toBe(rejected[0]);
    expect(written.map((log) => log.message)).toEqual([
      'Failed when executing sql',
      'Failed to write a statement log line',
    ]);
  });

  test('a writer that throws, inside a transaction: the transaction rejects with the vendor`s error itself', async () => {
    internals.logger = loggerThatThrows(() => true);

    const outcome = await settle(() =>
      driver.runTransaction((transaction) => driver.runDml(insertStatement, transaction))
    );

    expect(rejected).toHaveLength(1);
    expect(outcome).toBe(rejected[0]);
  });

  test('the values switch open and a writer that cannot serialize a bound value: the throw is still the vendor`s error itself', async () => {
    Object.assign(process.env, { DEVELOPMENT: 'true', DB_LOG_PARAM_VALUES: '1' });
    // A structured writer: it serializes what it is handed, and a bigint cannot be serialized.
    internals.logger = new Logger({
      name: 'KnexDriver',
      logLevel: 'debug',
      logWriter: {
        write: (log: CapturedLog) => {
          written.push({ logLevel: log.logLevel, message: log.message });
          JSON.stringify(log.obj);
        },
      } as any,
    });

    const outcome = await settle(() => driver.runDml(() => ({ sql: INSERT, params: [BigInt(7), CANARY] })));

    expect(rejected).toHaveLength(1);
    expect(outcome).toBe(rejected[0]);
    expect(written.map((log) => log.message)).toEqual([
      'Failed when executing sql',
      'Failed to write a statement log line',
    ]);
  });

  /** Bindings of every shape, at the door: what the driver throws is what a bare query-layer call throws. */
  const DOORS: [string, string, () => unknown][] = [
    ['positional bindings', 'SELECT 1 FROM `credential` WHERE `id` = ? AND `token` = ?', () => [1, CANARY]],
    [
      'a bindings dictionary',
      'SELECT 1 FROM `credential` WHERE `id` = :id AND `token` = :token',
      () => ({ id: 1, token: CANARY }),
    ],
    [
      'a dictionary with no prototype',
      'SELECT 1 FROM `credential` WHERE `token` = :token',
      () => Object.assign(Object.create(null), { token: CANARY }),
    ],
    ['nothing', 'SELECT 1 FROM `credential`', () => undefined],
    ['null', 'SELECT 1 FROM `credential` WHERE `token` = ?', () => null],
    ['a scalar string', 'SELECT 1 FROM `credential` WHERE `token` = ?', () => CANARY],
    ['zero', 'SELECT 1 FROM `credential` WHERE `n` = ?', () => 0],
    ['a Map', 'SELECT 1 FROM `credential` WHERE `token` = ?', () => new Map([['token', CANARY]])],
    ['a Date', 'SELECT 1 FROM `credential` WHERE `at` = ?', () => new Date(0)],
    ['bytes', 'SELECT 1 FROM `credential` WHERE `token` = ?', () => Buffer.from(CANARY)],
    [
      'fewer bindings than placeholders — the query layer refuses the statement itself',
      'SELECT 1 FROM `credential` WHERE `id` = ? AND `token` = ?',
      () => [CANARY],
    ],
    [
      'a dictionary with an entry whose accessor throws',
      'SELECT 1 FROM `credential` WHERE `id` = :id AND `token` = :token',
      () => throwingEntry({ id: 1 }, 'token'),
    ],
    [
      'a value whose toJSON throws',
      'SELECT 1 FROM `credential` WHERE `token` = ?',
      () => [
        {
          token: CANARY,
          toJSON: () => {
            throw ACCESSOR_ERROR;
          },
        },
      ],
    ],
    ['revoked bindings', 'SELECT 1 FROM `credential` WHERE `token` = ?', () => revoked([CANARY])],
  ];

  test.each(DOORS)(
    'at the door — %s: the throw reads as a bare query-layer call`s, and the line carries no value',
    async (_shape, sql, bindings) => {
      const bare = await settle(() => instance.raw(sql, bindings() as any) as any);
      // The premise: a bare query-layer call with these bindings fails.
      expect(bare).not.toBe('resolved');
      const bareRejections = rejected.length;
      const bareThrewTheVendorError = bare === rejected[0];
      rejected.length = 0;

      const outcome = await settle(() => driver.runQuery(() => ({ sql, params: bindings() as any })));

      expect(facts(outcome)).toEqual(facts(bare));
      expect(rejected).toHaveLength(bareRejections);
      // The very object, wherever the test can name it: the one the client library rejected with
      // (when that is what a bare call throws), or the one a throwing accessor throws.
      if (bareThrewTheVendorError) {
        expect(outcome).toBe(rejected[0]);
      }
      if (bare === ACCESSOR_ERROR) {
        expect(outcome).toBe(ACCESSOR_ERROR);
      }
      expect(written.map((log) => log.message)).toEqual(['Failed when executing sql']);
      expect(written[0].obj.sql).toBe(sql);
      expect(lineOf(written[0])).not.toContain(CANARY);
    }
  );
});
