import { inspect } from 'util';
import knex from 'knex';
import { KnexDriver, KnexLogValues, KnexOperationError } from '@proteinjs/db-driver-knex';
import { Logger } from '@proteinjs/logger';

/**
 * The dev-only values switch (`KnexLogValues`): the driver's failure line carries REAL values — the
 * statement's bound parameters, the vendor's own message — only when BOTH `DEVELOPMENT` is set AND
 * `DB_LOG_PARAM_VALUES=1`. With either gate closed: never.
 *
 * By default the line describes the parameters and names the failure by its codes (the rest of
 * this lane's suites hold that). On a local dev database the values are what locates a bug, so
 * there — and only there — the line adds `paramValues` and `vendorMessage`. The error a caller
 * CATCHES stays value-free with the switch on: the switch adds fields to a line and changes
 * nothing else.
 *
 * No server is needed: the REAL query layer and dialect run over a stub connection that rejects
 * the way the client library does.
 */

// Fixture values shaped like row content (none is a real credential).
const VALUE = 'rst_5d41402abc4b2a76b9719d911017c592';
const VENDOR_WORDS = 'Duplicate entry';

type DriverInternals = { logger: Logger };
type DriverStatics = { KNEX?: unknown };
type CapturedLog = { logLevel: string; message?: string; obj?: any; error?: any };

/** An error as anything that prints errors would print it (every inspection option included). */
const printed = (error: any): string =>
  [
    String(error?.message ?? error),
    String(error?.stack),
    inspect({ error }, { depth: 10, maxStringLength: null }),
    inspect(error, { depth: 10, maxStringLength: null, showHidden: true, getters: true }),
    inspect(error, { depth: 10, maxStringLength: null, showHidden: true, getters: true, customInspect: false }),
    JSON.stringify(error) ?? '',
  ].join('\n');

const lineOf = (log: CapturedLog): string =>
  [
    log.logLevel,
    log.message ?? '',
    inspect(log.obj, { depth: 10, maxStringLength: null }),
    JSON.stringify(log.obj) ?? '',
    log.error ? printed(log.error) : '',
  ].join('\n');

/** A connection that rejects every statement like a duplicate entry whose text quotes the first binding. */
const rejectingConnection = () => ({
  state: 'authenticated',
  on: () => undefined,
  removeAllListeners: () => undefined,
  connect: (done: (error?: Error) => void) => done(),
  end: (done: (error?: Error) => void) => done(),
  query: (options: { sql: string }, bindings: any[], done: (error: Error) => void) => {
    const sqlMessage = `${VENDOR_WORDS} '${bindings[0]}' for key 'PRIMARY'`;
    done(
      Object.assign(new Error(`ER_DUP_ENTRY: ${sqlMessage}`), {
        code: 'ER_DUP_ENTRY',
        errno: 1062,
        sqlState: '23000',
        sqlMessage,
        sql: options.sql,
      })
    );
  },
});

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

describe('the dev-only values switch: real values ride the driver`s failure line only behind both gates', () => {
  const driver = new KnexDriver({ host: 'localhost', user: 'root', password: '', dbName: 'test' });
  const internals = driver as unknown as DriverInternals;
  const statics = KnexDriver as unknown as DriverStatics;
  const ENV = [KnexLogValues.DEVELOPMENT_VAR, KnexLogValues.SWITCH_VAR];
  const envBefore: { [name: string]: string | undefined } = {};
  let captured: CapturedLog[] = [];
  let instance: ReturnType<typeof knex>;
  let previousInstance: unknown;

  beforeAll(() => {
    instance = knex({ client: 'mysql', connection: { host: 'localhost', user: 'root', password: '' } });
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

  const params = [VALUE, 42, null];
  const settle = (promise: Promise<unknown>): Promise<any> =>
    promise.then(
      () => 'resolved',
      (error: unknown) => error
    );

  test.each(GATES)('%s', async (_gate, env, on) => {
    Object.assign(process.env, env);

    const caught = [
      await settle(
        driver.runDml(() => ({ sql: 'INSERT INTO `credential` (`id`, `n`, `cleared`) VALUES (?, ?, ?)', params }))
      ),
      await settle(driver.runQuery(() => ({ sql: 'SELECT `n` FROM `credential` WHERE `id` = ?', params: [VALUE] }))),
    ];
    const failureLines = captured.filter((log) => log.message === 'Failed when executing sql');

    expect(KnexLogValues.enabled()).toBe(on);
    // The premise, at every gate: one failure line per statement, and the vendor error does quote the value.
    expect(failureLines).toHaveLength(2);
    for (const error of caught) {
      expect(error).toBeInstanceOf(KnexOperationError);
      expect(String(error.vendorError().message)).toContain(VALUE);
      // What a caller catches is value-free whatever the switch says.
      expect(printed(error)).not.toContain(VALUE);
      expect(printed(error)).not.toContain(VENDOR_WORDS);
    }
    if (!on) {
      for (const log of captured) {
        expect(lineOf(log)).not.toContain(VALUE);
        expect(lineOf(log)).not.toContain(VENDOR_WORDS);
        expect(Object.keys(log.obj ?? {})).not.toContain('paramValues');
        expect(Object.keys(log.obj ?? {})).not.toContain('vendorMessage');
      }
      return;
    }
    // The values as bound and the vendor's message as it arrived, BESIDE the description and the codes — which stay.
    expect(failureLines[0].obj).toEqual({
      sql: 'INSERT INTO `credential` (`id`, `n`, `cleared`) VALUES (?, ?, ?)',
      params: [{ type: 'string', length: VALUE.length }, { type: 'number' }, { type: 'null', null: true }],
      cause: { name: 'Error', code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000' },
      paramValues: params,
      vendorMessage: caught[0].vendorError().message,
    });
    expect(failureLines[0].obj.vendorMessage).toContain(`${VENDOR_WORDS} '${VALUE}'`);
    expect(failureLines[1].obj.paramValues).toEqual([VALUE]);
    expect(failureLines[1].obj.vendorMessage).toContain(`${VENDOR_WORDS} '${VALUE}'`);
  });
});
