import knex from 'knex';
import { KnexDriver } from '@proteinjs/db-driver-knex';
import { Logger } from '@proteinjs/logger';
import { CapturedLog, lineOf } from './util/printedLine';

/**
 * The vendor's text never reaches a LOG LINE — the driver's own line, and any line a caller
 * writes about the error it caught — while what the driver THROWS is the vendor's error itself,
 * untouched (StatementParamLogging.test.ts holds that law; here the premise of every scenario is
 * that the caught error still carries the values).
 *
 * The vendor error carries a statement's values three ways: the query layer rewrites its
 * `message` to the SQL with every binding INTERPOLATED, the client library carries the same text
 * as `sql`, and the server's own message quotes the value it refused (`Duplicate entry '<key>'
 * for key 'PRIMARY'`). The driver's line never carried the first two; it did carry the third, and
 * a caller that logged what it caught — whole, as a line's `error` or inside its `obj` — printed
 * all three.
 *
 * So a line carries the vendor's CODES and the driver's own sentence. No server is needed: the
 * REAL query layer and dialect run over a stub connection that rejects the way the client library
 * does; lines are captured at the log WRITER and judged as the text a writer would print.
 */

// Fixture values shaped like the row content that must never be logged (none is a real credential).
const SECRET_TOKEN = 'rst_5d41402abc4b2a76b9719d911017c592';
const SECRET_EMAIL = 'casey.rivers@mail.example';
const ECHOED_KEY = 'c0ffee00-0000-4000-8000-000000000001';
const VALUES = [SECRET_TOKEN, SECRET_EMAIL, ECHOED_KEY];

type DriverStatics = { KNEX?: unknown };

/** What the stub's COMMIT answers with; nothing, unless a test says otherwise. */
let commitRejection: (() => Error) | undefined;

/** A connection that rejects every statement the way the client library does on a duplicate key. */
const rejectingConnection = () => {
  const mysql = require('mysql');
  return {
    state: 'authenticated',
    on: () => undefined,
    removeAllListeners: () => undefined,
    connect: (done: (error?: Error) => void) => done(),
    end: (done: (error?: Error) => void) => done(),
    query: (options: { sql: string }, bindings: any[], done: (error: Error | null, rows?: unknown[]) => void) => {
      if (/^\s*COMMIT/i.test(options.sql) && commitRejection) {
        done(commitRejection());
        return;
      }
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(options.sql)) {
        done(null, []);
        return;
      }
      if (/^\s*SELECT 1/i.test(options.sql)) {
        done(null, [[{ 1: 1 }], []]);
        return;
      }
      const sqlMessage = `Duplicate entry '${bindings[0]}' for key 'PRIMARY'`;
      done(
        Object.assign(new Error(`ER_DUP_ENTRY: ${sqlMessage}`), {
          code: 'ER_DUP_ENTRY',
          errno: 1062,
          sqlState: '23000',
          sqlMessage,
          sql: mysql.format(options.sql, bindings),
        })
      );
    },
  };
};

const settle = <T>(promise: Promise<T>): Promise<any> =>
  promise.then(() => 'resolved' as const).catch((error) => error);

describe('the vendor`s text never reaches a log line; the thrown error still carries it', () => {
  const driver = new KnexDriver({ host: 'localhost', user: 'root', password: '', dbName: 'test' });
  const internals = driver as unknown as { logger: Logger };
  const statics = KnexDriver as unknown as DriverStatics;
  let captured: CapturedLog[] = [];
  let instance: ReturnType<typeof knex>;
  let previousInstance: unknown;
  const capturing = (name: string) =>
    new Logger({
      name,
      logLevel: 'debug',
      logWriter: { write: (log: CapturedLog) => captured.push(log) } as any,
    });
  const callerLogger = capturing('ACaller');

  beforeAll(() => {
    instance = knex({ client: 'mysql', connection: { host: 'localhost', user: 'root', password: '' } });
    (instance as any).client.driver = { createConnection: rejectingConnection };
    previousInstance = statics.KNEX;
    statics.KNEX = instance;
    internals.logger = capturing('KnexDriver');
  });

  afterAll(async () => {
    statics.KNEX = previousInstance;
    await instance.destroy();
  });

  beforeEach(() => {
    captured = [];
    commitRejection = undefined;
  });

  const INSERT = 'INSERT INTO `credential` (`id`, `email`, `token`, `attempts`, `cleared`) VALUES (?, ?, ?, ?, ?)';
  const insertStatement = () => ({ sql: INSERT, params: [ECHOED_KEY, SECRET_EMAIL, SECRET_TOKEN, 3, null] });

  /** The caller logs what it caught; no line — the driver's or the caller's — carries a value. */
  const assertNeverOnALine = (caught: any) => {
    callerLogger.error({ message: 'A caller`s own line about what it caught', error: caught });
    callerLogger.warn({ message: 'A caller`s own line about what it caught', obj: { caught, list: [caught] } });

    expect(captured.filter((log) => log.message === 'A caller`s own line about what it caught')).toHaveLength(2);
    for (const log of captured) {
      for (const value of VALUES) {
        expect(lineOf(log)).not.toContain(value);
      }
    }
  };

  test('a failed statement: the caught error carries every value; the driver`s line and a caller`s lines carry the codes and the sentence', async () => {
    const caught = await settle(driver.runDml(insertStatement));

    // The premise: the vendor error, as thrown, carries the values all three ways.
    expect(caught.message).toContain(SECRET_TOKEN);
    expect(caught.sql).toContain(SECRET_EMAIL);
    expect(caught.sqlMessage).toContain(ECHOED_KEY);

    assertNeverOnALine(caught);
    const [failure] = captured.filter((log) => log.message === 'Failed when executing sql');
    expect(failure.obj.cause).toEqual({
      name: 'Error',
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlState: '23000',
      sentence: 'a row with that key already exists',
    });
    const [callersLine] = captured.filter((log) => log.message === 'A caller`s own line about what it caught');
    expect(callersLine.error.message).toBe(
      'Failed when executing sql (ER_DUP_ENTRY, errno 1062): a row with that key already exists'
    );
    expect(callersLine.error).toMatchObject({ code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000' });
    expect(String(callersLine.error.stack).split('\n').length).toBeGreaterThan(1);
  });

  test.each([
    ['DEVELOPMENT set AND DB_LOG_PARAM_VALUES=1', { DEVELOPMENT: 'true', DB_LOG_PARAM_VALUES: '1' }, true],
    ['DEVELOPMENT unset, DB_LOG_PARAM_VALUES=1', { DB_LOG_PARAM_VALUES: '1' }, false],
    ['DEVELOPMENT set, DB_LOG_PARAM_VALUES unset', { DEVELOPMENT: 'true' }, false],
  ])(
    'the vendor`s text rides a line only behind the dev-only values switch — %s',
    async (_gate, env: { [name: string]: string }, open) => {
      const before = { DEVELOPMENT: process.env.DEVELOPMENT, DB_LOG_PARAM_VALUES: process.env.DB_LOG_PARAM_VALUES };
      delete process.env.DEVELOPMENT;
      delete process.env.DB_LOG_PARAM_VALUES;
      Object.assign(process.env, env);
      try {
        const caught = await settle(driver.runDml(insertStatement));
        callerLogger.error({ message: 'A caller`s own line', error: caught });

        const [callersLine] = captured.filter((log) => log.message === 'A caller`s own line');
        const [failure] = captured.filter((log) => log.message === 'Failed when executing sql');
        if (open) {
          expect(callersLine.error).toBe(caught);
          expect(failure.obj.cause.sqlMessage).toContain(ECHOED_KEY);
        } else {
          expect(callersLine.error).not.toBe(caught);
          expect(Object.keys(failure.obj.cause)).not.toContain('sqlMessage');
          for (const log of captured) {
            expect(lineOf(log)).not.toContain(ECHOED_KEY);
          }
        }
      } finally {
        for (const [name, value] of Object.entries(before)) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      }
    }
  );

  test('the same inside a transaction', async () => {
    const caught = await settle(driver.runTransaction((transaction) => driver.runDml(insertStatement, transaction)));

    expect(caught.message).toContain(SECRET_TOKEN);
    assertNeverOnALine(caught);
  });

  test('a commit the server refuses leaves through the transaction`s door, marked there; a caller`s own error thrown in the body prints as it is', async () => {
    commitRejection = () =>
      Object.assign(new Error(`ER_DUP_ENTRY: Duplicate entry '${ECHOED_KEY}' for key 'email'`), {
        code: 'ER_DUP_ENTRY',
        errno: 1062,
        sqlState: '23000',
        sqlMessage: `Duplicate entry '${ECHOED_KEY}' for key 'email'`,
      });
    const refusedCommit = await settle(driver.runTransaction(async () => 'the body ran clean'));

    expect(String(refusedCommit.message)).toContain(ECHOED_KEY);
    assertNeverOnALine(refusedCommit);

    captured = [];
    commitRejection = undefined;
    const callersOwn = new Error('The order is already closed');
    const outcome = await settle(
      driver.runTransaction(async () => {
        throw callersOwn;
      })
    );
    callerLogger.error({ message: 'A caller`s own line', error: outcome });

    expect(outcome).toBe(callersOwn);
    expect(captured[0].error).toBe(callersOwn);
  });
});
