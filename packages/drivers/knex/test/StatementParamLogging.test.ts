import { inspect } from 'util';
import knex from 'knex';
import { KnexDriver, KnexOperationError } from '@proteinjs/db-driver-knex';
import { Logger } from '@proteinjs/logger';

/**
 * A bound parameter's VALUE never reaches a log line, nor the error the driver throws. A
 * statement's parameters are row content: a presented reset token, a password hash, an email
 * address. Before this contract a failed statement put every bound value on the ERROR line twice
 * over — the query layer rewrites a failed query's `message` to the SQL with its bindings
 * INTERPOLATED, and the client library's error carries the same formatted text as `sql` — because
 * the driver handed that vendor error to the logger and rethrew it as is.
 *
 * The contract: the failure line carries the SQL text (placeholders only), the parameters
 * DESCRIBED — each one's position, the kind of its value and, for strings, arrays and bytes, its
 * length; one private helper (`describeParams`) owns that form — and the failure's codes; the
 * throw is a `KnexOperationError` that carries no value however it is printed — its message, its
 * stack, its serialized form, its `util.inspect` rendering (what `console.*` and the default dev
 * log writer print, which follows a `cause` even when it is not enumerable) — with the vendor
 * error behind its `vendorError()` method and the vendor codes copied for callers.
 *
 * No server is needed: the REAL query layer and dialect run over a stub connection that rejects
 * the way the client library does (its own `format` builds the interpolated `sql`), so the
 * interpolated message under test is the query layer's own.
 */

// Fixture values shaped like the row content that must never be logged (none is a real credential).
const SECRET_TOKEN = 'rst_5d41402abc4b2a76b9719d911017c592';
const SECRET_EMAIL = 'casey.rivers@mail.example';

type ParamDescription = { type: string; length?: number; null?: true };
type DriverInternals = {
  logger: Logger;
  describeParams: (params?: any[]) => ParamDescription[] | undefined;
};
type DriverStatics = { KNEX?: unknown };
type CapturedLog = { logLevel: string; message?: string; obj?: any; error?: any };

/** An error as a writer would print it: inspected (the default dev writer) and serialized (a structured one). */
const printed = (error: any): string =>
  [error.message, error.stack, inspect({ error }, { depth: 10, maxStringLength: null }), JSON.stringify(error)].join(
    '\n'
  );

/** The text a log writer would print for a captured line. */
const lineOf = (log: CapturedLog): string =>
  [
    log.logLevel,
    log.message ?? '',
    inspect(log.obj, { depth: 10, maxStringLength: null, maxArrayLength: null }),
    log.error ? printed(log.error) : '',
  ].join('\n');

/** A connection that rejects every query the way the client library does on a duplicate key. */
const rejectingConnection = () => {
  const mysql = require('mysql');
  return {
    state: 'authenticated',
    on: () => undefined,
    removeAllListeners: () => undefined,
    connect: (done: (error?: Error) => void) => done(),
    end: (done: (error?: Error) => void) => done(),
    query: (options: { sql: string }, bindings: any[], done: (error: Error) => void) => {
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

describe('A bound value never reaches a log line or a thrown error', () => {
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
  });

  const failingInsert = () =>
    driver.runDml(() => ({
      sql: 'INSERT INTO `credential` (`id`, `email`, `token`, `attempts`, `cleared`) VALUES (?, ?, ?, ?, ?)',
      params: ['c0ffee00-0000-4000-8000-000000000001', SECRET_EMAIL, SECRET_TOKEN, 3, null],
    }));

  test('the premise: the vendor error of a failed statement carries the bound values', async () => {
    const vendorError = await (instance.raw('INSERT INTO `t` (`token`) VALUES (?)', [SECRET_TOKEN]) as any).then(
      () => undefined,
      (error: any) => error
    );

    expect(vendorError.message).toContain(SECRET_TOKEN);
    expect(vendorError.sql).toContain(SECRET_TOKEN);
  });

  test('a failed statement: the error line describes each parameter and carries no value', async () => {
    await failingInsert().catch(() => undefined);

    const failures = captured.filter((log) => log.logLevel === 'error' && log.message === 'Failed when executing sql');
    expect(failures).toHaveLength(1);
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(SECRET_TOKEN);
      expect(lineOf(log)).not.toContain(SECRET_EMAIL);
      expect(lineOf(log)).not.toContain('c0ffee00');
    }
    const [failure] = failures;
    expect(failure.obj.sql).toContain('VALUES (?, ?, ?, ?, ?)');
    expect(failure.obj.params).toEqual([
      { type: 'string', length: 36 },
      { type: 'string', length: SECRET_EMAIL.length },
      { type: 'string', length: SECRET_TOKEN.length },
      { type: 'number' },
      { type: 'null', null: true },
    ]);
    expect(failure.obj.cause).toEqual({ name: 'Error', code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000' });
  });

  test('the throw is the typed error: the vendor codes kept, the vendor error beside it, no value however it is printed', async () => {
    const outcome: any = await failingInsert().then(
      () => 'resolved',
      (error: unknown) => error
    );

    expect(printed(outcome)).not.toContain(SECRET_TOKEN);
    expect(printed(outcome)).not.toContain(SECRET_EMAIL);
    expect(printed(outcome)).not.toContain('c0ffee00');
    expect(outcome).toBeInstanceOf(KnexOperationError);
    expect(outcome.code).toBe('ER_DUP_ENTRY');
    expect(outcome.errno).toBe(1062);
    expect(outcome.sqlState).toBe('23000');
    expect(outcome.message).toBe('Failed when executing sql (ER_DUP_ENTRY, errno 1062)');
    // The vendor error rides for callers, out of a printer's reach: not enumerable, not a `cause`.
    expect(outcome.vendorError().sqlMessage).toContain('Duplicate entry');
    expect(Object.keys(outcome)).not.toContain('vendorError');
    expect('cause' in outcome).toBe(false);
  });

  test('a failed query rides the same door', async () => {
    const outcome = await driver
      .runQuery(() => ({ sql: 'SELECT `id` FROM `credential` WHERE `token` = ?', params: [SECRET_TOKEN] }))
      .then(
        () => 'resolved',
        (error: unknown) => error
      );

    expect(outcome).toBeInstanceOf(KnexOperationError);
    const failures = captured.filter((log) => log.logLevel === 'error');
    expect(failures).toHaveLength(1);
    expect(failures[0].obj.params).toEqual([{ type: 'string', length: SECRET_TOKEN.length }]);
    expect(lineOf(failures[0])).not.toContain(SECRET_TOKEN);
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
