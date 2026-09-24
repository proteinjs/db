import knex from 'knex';
import { KnexDriver } from '@proteinjs/db-driver-knex';
import { Logger } from '@proteinjs/logger';

/**
 * The driver's per-operation deadline: every query and DML statement runs under it, and the driver
 * reports it (`DbDriver.getOperationDeadlineMs`) — so code that sizes a wait by the driver's
 * deadline is sized by a bound the driver actually enforces. A statement the server never answers
 * fails AT the deadline with an error naming it, and the statement is cancelled on the server
 * (`KILL QUERY` naming the connection it runs on), instead of holding its connection indefinitely.
 *
 * No server is needed: the REAL query layer and dialect run over a stub connection that answers
 * transaction control and `KILL QUERY`, and never answers any other statement.
 */

type DriverStatics = { KNEX?: unknown };
type DriverInternals = { logger: Logger };

/** The thread ids of the connections a statement was left unanswered on. */
const unanswered: number[] = [];
/** Every `KILL QUERY` the stub server received, by the thread id it named. */
const killed: number[] = [];
let nextThreadId = 100;

/** A connection whose server never answers a statement — until it is killed. */
const silentConnection = () => {
  const threadId = nextThreadId++;
  return {
    threadId,
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
      if (/^\s*KILL QUERY/i.test(options.sql)) {
        killed.push(bindings[0]);
        done(null, []);
        return;
      }
      // Never answered: the statement a dead link or a stuck server leaves in flight.
      unanswered.push(threadId);
    },
  };
};

const config = { host: 'localhost', user: 'root', password: '', dbName: 'test' };
const statement = () => ({ sql: 'SELECT `id` FROM `row` WHERE `id` = ?', params: ['row-1'] });

describe('The knex driver`s per-operation deadline: reported, and enforced on every statement', () => {
  const statics = KnexDriver as unknown as DriverStatics;
  let instance: ReturnType<typeof knex>;
  let previousInstance: unknown;

  beforeAll(() => {
    instance = knex({ client: 'mysql', connection: { host: 'localhost', user: 'root', password: '' } });
    // The dialect's own connection lifecycle, over a stub client library.
    (instance as any).client.driver = { createConnection: silentConnection };
    previousInstance = statics.KNEX;
    statics.KNEX = instance;
  });

  afterAll(async () => {
    statics.KNEX = previousInstance;
    await instance.destroy();
  });

  beforeEach(() => {
    unanswered.length = 0;
    killed.length = 0;
  });

  /** A driver with `deadlineMs`, its failure lines kept off the test output. */
  const driverWith = (deadlineMs: number) => {
    const driver = new KnexDriver({ ...config, operationDeadlineMs: deadlineMs });
    (driver as unknown as DriverInternals).logger = new Logger({
      name: 'KnexDriver',
      logWriter: { write: () => undefined } as any,
    });
    return driver;
  };

  test('the driver reports the deadline it is configured with, and 60 s when none is configured', () => {
    expect(driverWith(500).getOperationDeadlineMs()).toBe(500);
    expect(new KnexDriver(config).getOperationDeadlineMs()).toBe(60_000);
  });

  test('a statement the server never answers fails AT the deadline, naming it, and is cancelled on the server', async () => {
    const driver = driverWith(500);

    const before = Date.now();
    await expect(driver.runQuery(statement)).rejects.toThrow(/Defined query timeout of 500ms exceeded/);
    const elapsed = Date.now() - before;

    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(3_000);
    // The cancel named the connection the statement was left on.
    expect(unanswered).toHaveLength(1);
    expect(killed).toEqual(unanswered);
  }, 10_000);

  test('a statement inside a transaction runs under the same deadline, and the transaction fails with it', async () => {
    const driver = driverWith(500);

    const before = Date.now();
    await expect(driver.runTransaction((transaction) => driver.runDml(statement, transaction))).rejects.toThrow(
      /Defined query timeout of 500ms exceeded/
    );

    expect(Date.now() - before).toBeLessThan(3_000);
    expect(unanswered).toHaveLength(1);
    expect(killed).toEqual(unanswered);
  }, 10_000);
});
