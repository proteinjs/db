import knex from 'knex';
import { KnexDriver, KnexLogValues } from '@proteinjs/db-driver-knex';
import { Logger } from '@proteinjs/logger';
import { CapturedLog, lineOf } from './util/printedLine';

/**
 * The dev-only values switch (`KnexLogValues`): the driver's failure line carries the REAL values
 * of the bound parameters — `paramValues`, and the vendor error itself as `error` — only when BOTH
 * `DEVELOPMENT` is set AND `DB_LOG_PARAM_VALUES=1`. With either gate closed: never.
 *
 * By default the line describes the parameters and summarizes the failure
 * (StatementParamLogging.test.ts holds that). On a local dev database the values are what locates
 * a bug, so there — and only there — the line adds them, beside the description, which stays. What
 * a caller CATCHES is the same error whatever the switch says: the switch adds fields to a line
 * and changes nothing else.
 *
 * No server is needed: the REAL query layer and dialect run over a stub connection that rejects
 * the way the client library does. The stub server's message quotes no bound value: what the
 * SERVER echoes is not this switch's subject (see StatementParamLogging.test.ts's header).
 */

// A fixture value shaped like row content (not a real credential).
const VALUE = 'rst_5d41402abc4b2a76b9719d911017c592';

type DriverInternals = { logger: Logger };
type DriverStatics = { KNEX?: unknown };

/** A connection that rejects every statement like a missing table — a server message that quotes no binding. */
const rejectingConnection = () => {
  const mysql = require('mysql');
  return {
    state: 'authenticated',
    on: () => undefined,
    removeAllListeners: () => undefined,
    connect: (done: (error?: Error) => void) => done(),
    end: (done: (error?: Error) => void) => done(),
    query: (options: { sql: string }, bindings: any[], done: (error: Error) => void) => {
      const sqlMessage = `Table 'test.credential' doesn't exist`;
      done(
        Object.assign(new Error(`ER_NO_SUCH_TABLE: ${sqlMessage}`), {
          code: 'ER_NO_SUCH_TABLE',
          errno: 1146,
          sqlState: '42S02',
          sqlMessage,
          sql: mysql.format(options.sql, bindings),
        })
      );
    },
  };
};

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

  const params = [VALUE, 42];
  const failingInsert = (): Promise<any> =>
    driver
      .runDml(() => ({ sql: 'INSERT INTO `credential` (`id`, `n`) VALUES (?, ?)', params }))
      .then(
        () => 'resolved',
        (error: unknown) => error
      );
  /** Everything a caller can read off a caught error. */
  const facts = (error: any) => ({
    class: error.constructor.name,
    message: error.message,
    own: Object.getOwnPropertyNames(error)
      .sort()
      .map((name) => [name, name === 'stack' ? '(stack)' : error[name]]),
  });

  test.each(GATES)('%s', async (_gate, env, on) => {
    // The error a caller catches with the switch untouched — what every gate must reproduce.
    const baseline = facts(await failingInsert());
    captured = [];
    Object.assign(process.env, env);

    const caught = await failingInsert();

    expect(KnexLogValues.enabled()).toBe(on);
    const failures = captured.filter((log) => log.message === 'Failed when executing sql');
    expect(failures).toHaveLength(1);
    const [failure] = failures;
    // What a caller catches is the same whatever the switch says.
    expect(facts(caught)).toEqual(baseline);
    // The description and the summary ride the line at every gate.
    expect(failure.obj.params).toEqual([{ type: 'string', length: VALUE.length }, { type: 'number' }]);
    expect(failure.obj.cause).toEqual({
      name: 'Error',
      code: 'ER_NO_SUCH_TABLE',
      errno: 1146,
      sqlState: '42S02',
      sqlMessage: `Table 'test.credential' doesn't exist`,
    });
    if (!on) {
      for (const log of captured) {
        expect(lineOf(log)).not.toContain(VALUE);
        expect(Object.keys(log.obj ?? {})).not.toContain('paramValues');
        expect(log.error).toBeUndefined();
      }
      return;
    }
    // The values as bound, BESIDE the description; and the vendor error itself, as it was thrown.
    expect(failure.obj.paramValues).toEqual(params);
    expect(failure.error).toBe(caught);
    expect(lineOf(failure)).toContain(VALUE);
  });
});
