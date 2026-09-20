import knex from 'knex';
import { KnexDriver } from '@proteinjs/db-driver-knex';
import { Logger } from '@proteinjs/logger';
import { CapturedLog, lineOf } from './util/printedLine';

/**
 * The driver never PRINTS a bound parameter's value. A statement's parameters are row content: a
 * presented reset token, a password hash, an email address. Before this contract a failed
 * statement put every bound value on the ERROR line twice over — the query layer rewrites a failed
 * query's `message` to the SQL with its bindings INTERPOLATED, and the client library's error
 * carries the same formatted text as `sql` — because the driver handed that vendor error to the
 * logger.
 *
 * The contract: the failure line carries the SQL text (placeholders only), the parameters
 * DESCRIBED — each one's position, the kind of its value and, for strings, arrays and bytes, its
 * length; one private helper (`describeParams`) owns that form — and a summary of the failure (the
 * error's name, the vendor's codes, the server's own message). The vendor error itself no longer
 * rides the line. (The dev-only switch that adds the values back is LogValuesSwitch.test.ts; it is
 * off here.)
 *
 * THE LAW beside it: what the driver THROWS is untouched — the vendor's error itself, the same
 * object with the same message and properties a bare query-layer call rejects with. So a caller
 * that prints what it catches still prints the interpolated SQL; that is the query layer's
 * behaviour and this contract does not change it.
 *
 * SCOPE, by name: this suite holds what the DRIVER prints of the parameters it was handed. It does
 * NOT hold the vendor-echo class — the server's own message can quote a bound value (`Duplicate
 * entry '…' for key 'PRIMARY'`), and that text reaches the line's cause summary and the thrown
 * error exactly as it did before. Closing that class means changing what the driver throws; that
 * work is parked on the branch `fix/driver-logs-never-carry-param-values`, pending a decision. So
 * the canaries below are bound to parameters the server does not echo, and the one value it does
 * echo — the colliding key — is left out of the assertions on purpose.
 *
 * No server is needed: the REAL query layer and dialect run over a stub connection that rejects
 * the way the client library does (its own `format` builds the interpolated `sql`), so the
 * interpolated message under test is the query layer's own.
 */

// Fixture values shaped like the row content that must never be logged (none is a real credential).
const SECRET_TOKEN = 'rst_5d41402abc4b2a76b9719d911017c592';
const SECRET_EMAIL = 'casey.rivers@mail.example';
const ECHOED_KEY = 'c0ffee00-0000-4000-8000-000000000001';

type ParamDescription = { type: string; length?: number; null?: true };
type DriverInternals = {
  logger: Logger;
  describeParams: (params?: any[]) => ParamDescription[] | undefined;
};
type DriverStatics = { KNEX?: unknown };

/** The errors the stub connection rejected with, as they left the client library's callback. */
const rejected: Error[] = [];

/** A connection that lets transaction control through and rejects every statement the way the client library does on a duplicate key. */
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
      const sqlMessage = `Duplicate entry '${bindings[0]}' for key 'PRIMARY'`;
      const error = Object.assign(new Error(`ER_DUP_ENTRY: ${sqlMessage}`), {
        code: 'ER_DUP_ENTRY',
        errno: 1062,
        sqlState: '23000',
        sqlMessage,
        sql: mysql.format(options.sql, bindings),
      });
      rejected.push(error);
      done(error);
    },
  };
};

const settle = <T>(promise: Promise<T>): Promise<any> =>
  promise.then(() => 'resolved' as const).catch((error) => error);

describe('The driver never prints a bound value; what it throws is the vendor`s error, untouched', () => {
  const driver = new KnexDriver({ host: 'localhost', user: 'root', password: '', dbName: 'test' });
  const internals = driver as unknown as DriverInternals;
  const statics = KnexDriver as unknown as DriverStatics;
  let captured: CapturedLog[] = [];
  let instance: ReturnType<typeof knex>;
  let previousInstance: unknown;

  beforeAll(() => {
    instance = knex({ client: 'mysql', connection: { host: 'localhost', user: 'root', password: '' } });
    // The dialect's own connection lifecycle, over a stub client library.
    (instance as any).client.driver = { createConnection: rejectingConnection };
    previousInstance = statics.KNEX;
    statics.KNEX = instance;
    internals.logger = new Logger({
      name: 'KnexDriver',
      logLevel: 'debug',
      logWriter: { write: (log: CapturedLog) => captured.push(log) } as any,
    });
  });

  afterAll(async () => {
    statics.KNEX = previousInstance;
    await instance.destroy();
  });

  beforeEach(() => {
    captured = [];
    rejected.length = 0;
  });

  const INSERT = 'INSERT INTO `credential` (`id`, `email`, `token`, `attempts`, `cleared`) VALUES (?, ?, ?, ?, ?)';
  const insertStatement = () => ({ sql: INSERT, params: [ECHOED_KEY, SECRET_EMAIL, SECRET_TOKEN, 3, null] });
  /** Everything a caller can read off a caught error. */
  const facts = (error: any) => ({
    class: error.constructor.name,
    message: error.message,
    own: Object.getOwnPropertyNames(error)
      .sort()
      .map((name) => [name, name === 'stack' ? '(stack)' : error[name]]),
  });

  test('the premise: the vendor error of a failed statement carries the bound values', async () => {
    const vendorError = await settle(instance.raw('INSERT INTO `t` (`token`) VALUES (?)', [SECRET_TOKEN]) as any);

    expect(vendorError.message).toContain(SECRET_TOKEN);
    expect(vendorError.sql).toContain(SECRET_TOKEN);
  });

  test('a failed statement: the error line describes each parameter and carries no value it was handed', async () => {
    await settle(driver.runDml(insertStatement));

    const failures = captured.filter((log) => log.logLevel === 'error' && log.message === 'Failed when executing sql');
    expect(failures).toHaveLength(1);
    // (`ECHOED_KEY` is NOT asserted: the server quotes the colliding key in its own message — the
    // vendor-echo class this suite leaves out by name; see the header.)
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(SECRET_TOKEN);
      expect(lineOf(log)).not.toContain(SECRET_EMAIL);
    }
    const [failure] = failures;
    expect(failure.obj.sql).toBe(INSERT);
    expect(failure.obj.params).toEqual([
      { type: 'string', length: 36 },
      { type: 'string', length: SECRET_EMAIL.length },
      { type: 'string', length: SECRET_TOKEN.length },
      { type: 'number' },
      { type: 'null', null: true },
    ]);
    expect(failure.obj.cause).toEqual({
      name: 'Error',
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlState: '23000',
      sqlMessage: `Duplicate entry '${ECHOED_KEY}' for key 'PRIMARY'`,
    });
    expect(Object.keys(failure.obj)).not.toContain('paramValues');
    // The vendor error itself — the carrier of the interpolated SQL — is not on the line.
    expect(failure.error).toBeUndefined();
  });

  test('the law: the throw is the vendor`s error itself — the object the client library rejected with, reading as a bare query-layer call`s does', async () => {
    const bare = await settle(instance.raw(INSERT, insertStatement().params) as any);
    rejected.length = 0;

    const outcome = await settle(driver.runDml(insertStatement));

    expect(rejected).toHaveLength(1);
    expect(outcome).toBe(rejected[0]);
    expect(facts(outcome)).toEqual(facts(bare));
    expect(outcome.code).toBe('ER_DUP_ENTRY');
  });

  test('a failed query rides the same door', async () => {
    const outcome = await settle(
      driver.runQuery(() => ({ sql: 'SELECT `id` FROM `credential` WHERE `token` = ?', params: [SECRET_TOKEN] }))
    );

    expect(outcome).toBe(rejected[0]);
    const failures = captured.filter((log) => log.logLevel === 'error');
    expect(failures).toHaveLength(1);
    expect(failures[0].obj.params).toEqual([{ type: 'string', length: SECRET_TOKEN.length }]);
    // This statement's first binding IS the token, so the stub server echoes it: the summary's
    // `sqlMessage` is the vendor-echo class. Everything else on the line is the driver's.
    const { sqlMessage, ...ownFacts } = failures[0].obj.cause;
    expect(sqlMessage).toContain(SECRET_TOKEN);
    expect(lineOf({ ...failures[0], obj: { ...failures[0].obj, cause: ownFacts } })).not.toContain(SECRET_TOKEN);
  });

  test('a failed statement inside a transaction: the same line, and the transaction rejects with the vendor`s error itself', async () => {
    const outcome = await settle(driver.runTransaction((transaction) => driver.runDml(insertStatement, transaction)));

    expect(rejected).toHaveLength(1);
    expect(outcome).toBe(rejected[0]);
    expect(captured.filter((log) => log.message === 'Failed when executing sql')).toHaveLength(1);
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(SECRET_TOKEN);
      expect(lineOf(log)).not.toContain(SECRET_EMAIL);
    }
  });
});

describe('describeParams — positions, kinds and lengths; never a value', () => {
  const internals = new KnexDriver({
    host: 'localhost',
    user: 'root',
    password: '',
    dbName: 'test',
  }) as unknown as DriverInternals;

  test('each positional parameter: the kind of its value, a length for strings, arrays and bytes, null named', () => {
    const described = internals.describeParams([
      SECRET_TOKEN,
      [SECRET_EMAIL, SECRET_TOKEN],
      3,
      true,
      new Date(0),
      Buffer.from(SECRET_TOKEN),
      { theme: SECRET_TOKEN },
      null,
      undefined,
    ]);

    expect(described).toEqual([
      { type: 'string', length: SECRET_TOKEN.length },
      { type: 'array', length: 2 },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'date' },
      { type: 'bytes', length: Buffer.from(SECRET_TOKEN).length },
      { type: 'object' },
      { type: 'null', null: true },
      { type: 'null', null: true },
    ]);
    expect(JSON.stringify(described)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(described)).not.toContain(SECRET_EMAIL);
  });

  test('a statement with no parameters describes nothing', () => {
    expect(internals.describeParams(undefined)).toBeUndefined();
  });
});
