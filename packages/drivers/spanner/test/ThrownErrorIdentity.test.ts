import * as fs from 'fs';
import * as path from 'path';
import { Transaction } from '@google-cloud/spanner';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { Logger } from '@proteinjs/logger';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';

/**
 * THE LAW of the statement-log contract: it changes what the driver LOGS about a statement's
 * parameters and NOTHING about what the driver THROWS. At every door a failure leaves through —
 * a query, a query whose failure arrives while its rows stream, a dml under the driver's own
 * transaction, the batch rpc rejected outright, a dml and a query on a caller's transaction, the
 * commit, a schema update (refused at validation, failed while applying, issued inside a
 * transaction body) — the thrown error is the one the release line throws: the same class, name,
 * message and code, the same own properties with the same enumerability, the same `details`,
 * `metadata` and `cause`, the same frames leading its stack. The client library's transaction
 * runner decides its retries off exactly those facts, so its behaviour is the release line's by
 * construction.
 *
 * The expectation is DATA: `ThrownErrorIdentity.recorded.json`, written once by THIS file, run
 * unchanged on a checkout of the release line (it imports nothing the release line lacks), and
 * committed. Every door is forced for real on the emulator; each transaction body carries a brake
 * (an attempt cap), because a retry that should not happen must end the test, not hang it. The
 * doors run with the driver's logger at debug — every statement line is written while the error
 * is made — and twice: with the dev-only values switch closed, and open.
 *
 * Re-recording. The recorded messages are the emulator's words passed through the driver, read
 * through one client library version. Each door first checks that premise (`backendSaid`, the
 * vendor's raw message, against the recording); when the emulator or the client library changes
 * its words, THAT assertion fails, and the recording is taken again from the release line:
 *
 *   THROWN_ERROR_IDENTITY_RECORD=<path to write> THROWN_ERROR_IDENTITY_SOURCE=<release sha> \
 *     npx jest --runInBand test/ThrownErrorIdentity.test.ts
 */

const RECORDING_PATH = path.join(__dirname, 'ThrownErrorIdentity.recorded.json');
const RECORD_TO = process.env.THROWN_ERROR_IDENTITY_RECORD;
const CLIENT_LIBRARY_VERSION: string = require('@google-cloud/spanner/package.json').version;

const TABLE = 'db_test_thrown_identity';
const DUPES = 'db_test_thrown_identity_dupes';
const KEY = 'identity-row-1';
const MAX_ATTEMPTS = 3;

type Facts = { [fact: string]: unknown };
type Observation = { backendSaid: string; transactionBodyRuns: number; thrown: Facts };
type Recording = {
  source: string;
  clientLibrary: string;
  doors: { [door: string]: Observation };
};

/** Reads the identity facts off a thrown error — everything a caller or the client library's runner can. */
class ThrownErrorFacts {
  of(error: unknown, depth = 0): Facts {
    if (!(error instanceof Error)) {
      return { notAnError: this.value(error, depth) };
    }
    const own: { [name: string]: unknown } = {};
    for (const name of Object.getOwnPropertyNames(error).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(error, name) as PropertyDescriptor;
      own[name] = {
        enumerable: descriptor.enumerable,
        writable: descriptor.writable,
        value: name === 'stack' ? '(see stack)' : this.value(descriptor.value, depth),
      };
    }
    return {
      class: error.constructor.name,
      classChain: this.classChain(error),
      name: error.name,
      message: error.message,
      code: this.value((error as { code?: unknown }).code, depth),
      own,
      stack: this.stackShape(error),
    };
  }

  private value(value: unknown, depth: number): unknown {
    if (value === undefined) {
      return '(undefined)';
    }
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (value instanceof Error) {
      return depth < 3 ? this.of(value, depth + 1) : '(error, deeper than recorded)';
    }
    if (Array.isArray(value)) {
      return value.map((element) => this.value(element, depth));
    }
    if (typeof value === 'object') {
      const getMap = (value as { getMap?: unknown }).getMap;
      if (typeof getMap === 'function') {
        return { class: value.constructor?.name, keys: Object.keys(getMap.call(value)).sort() };
      }
      if (value.constructor === Object) {
        return JSON.parse(JSON.stringify(value));
      }
      return { class: value.constructor?.name, keys: Object.keys(value).sort() };
    }
    return `(${typeof value})`;
  }

  private classChain(error: Error): string[] {
    const chain: string[] = [];
    for (let proto = Object.getPrototypeOf(error); proto && proto !== Object.prototype; ) {
      chain.push(proto.constructor.name);
      proto = Object.getPrototypeOf(proto);
    }
    return chain;
  }

  /** Whose frames lead the stack, and whether it opens with the error's own name and message. */
  private stackShape(error: Error): Facts {
    const stack = String(error.stack ?? '');
    const firstFrame = stack.split('\n').find((line) => /^\s+at /.test(line)) ?? '';
    return {
      opensWithNameAndMessage: stack.startsWith(`${error.name}: ${error.message}`),
      firstFrame: firstFrame.includes(path.basename(__filename).replace(/\.[jt]s$/, ''))
        ? 'the caller (this file)'
        : firstFrame.includes('/node_modules/')
          ? 'a dependency'
          : firstFrame
            ? 'other'
            : '(no frames)',
    };
  }
}

describe('what the driver throws is what the release line throws, at every door (emulator)', () => {
  const spannerConfig = { projectId: 'proteinjs-test', instanceName: 'proteinjs-test', databaseName: 'test' };
  const driver = new SpannerDriver(spannerConfig, () => undefined as any);
  const internals = driver as unknown as { logger: Logger };
  const facts = new ThrownErrorFacts();
  const observed: { [gate: string]: { [door: string]: Observation } } = {};
  let driverLogger: Logger;
  let linesWritten = 0;
  let transactionBodyRuns = 0;

  const insert = (id: string, n: string) => () => ({
    sql: `INSERT INTO \`${TABLE}\` (\`id\`, \`n\`) VALUES (@id, @n)`,
    namedParams: { params: { id, n }, types: { id: 'string', n: 'string' } },
  });
  const unknownColumn = () => ({
    sql: `SELECT \`id\` FROM \`${TABLE}\` WHERE \`no_such_column\` = @n`,
    namedParams: { params: { n: 'a bound value' }, types: { n: 'string' } },
  });
  /** A transaction body with a brake: a retry that should not happen ends the test instead of hanging it. */
  const braked = <T>(body: (transaction: Transaction) => Promise<T>) => {
    let attempts = 0;
    return async (transaction: Transaction): Promise<T> => {
      attempts += 1;
      transactionBodyRuns += 1;
      if (attempts > MAX_ATTEMPTS) {
        throw new Error(`BRAKE: attempt ${attempts} of a transaction that must run once`);
      }
      return await body(transaction);
    };
  };

  const DOORS: [string, () => Promise<unknown>][] = [
    ['query: refused (an unknown column)', () => driver.runQuery(unknownColumn)],
    [
      'stream: a query whose failure arrives while its rows are evaluated',
      () =>
        driver.runQuery(() => ({
          sql: `SELECT CAST(\`n\` AS INT64) AS \`n\` FROM \`${TABLE}\` WHERE \`id\` != @skip ORDER BY \`id\``,
          namedParams: { params: { skip: 'no such row' }, types: { skip: 'string' } },
        })),
    ],
    ['dml: the driver`s own transaction (a duplicate key)', () => driver.runDml(insert(KEY, 'again'))],
    [
      'batch: the rpc rejected outright (a dml on a transaction already rolled back)',
      () =>
        driver.runTransaction(
          braked(async (transaction) => {
            await driver.runDml(insert('identity-row-rolled-back', 'never lands'), transaction);
            await transaction.rollback();
            return await driver.runDml(insert('identity-row-late', 'never lands'), transaction);
          })
        ),
    ],
    [
      'transaction dml: a caller`s transaction (a duplicate key)',
      () => driver.runTransaction(braked((transaction) => driver.runDml(insert(KEY, 'again'), transaction))),
    ],
    [
      'transaction query: a caller`s transaction (an unknown column)',
      () => driver.runTransaction(braked((transaction) => driver.runQuery(unknownColumn, transaction))),
    ],
    [
      'commit: refused by the backend (a buffered duplicate row)',
      () =>
        driver.runTransaction(
          braked(async (transaction) => {
            transaction.insert(TABLE, { id: KEY, n: 'again' });
          })
        ),
    ],
    [
      'commit: after the body rolled the transaction back',
      () =>
        driver.runTransaction(
          braked(async (transaction) => {
            await driver.runDml(insert('identity-row-rolled-back', 'never lands'), transaction);
            await transaction.rollback();
          })
        ),
    ],
    [
      'schema update: refused at validation (a duplicate table)',
      () => driver.runUpdateSchema(`CREATE TABLE ${TABLE} (id STRING(MAX) NOT NULL) PRIMARY KEY (id)`),
    ],
    [
      'schema update: failed while applying (a unique index over duplicate rows)',
      () => driver.runUpdateSchema(`CREATE UNIQUE INDEX ${DUPES}_ix ON ${DUPES} (v)`),
    ],
    [
      'schema update: issued inside a transaction body',
      () =>
        driver.runTransaction(
          braked(() => driver.runUpdateSchema(`CREATE TABLE ${TABLE} (id STRING(MAX) NOT NULL) PRIMARY KEY (id)`))
        ),
    ],
  ];

  const observeEveryDoor = async (): Promise<{ [door: string]: Observation }> => {
    const observations: { [door: string]: Observation } = {};
    for (const [door, open] of DOORS) {
      transactionBodyRuns = 0;
      const outcome: any = await open().then(
        () => new Error(`the door did not fail: ${door}`),
        (error: unknown) => error
      );
      observations[door] = {
        backendSaid: String((outcome?.cause ?? outcome)?.message),
        transactionBodyRuns,
        thrown: facts.of(outcome),
      };
    }
    return observations;
  };

  const dropTables = async () => {
    for (const statement of [`DROP INDEX ${DUPES}_ix`, `DROP TABLE ${DUPES}`, `DROP TABLE ${TABLE}`]) {
      await driver.runUpdateSchema(statement).catch(() => undefined);
    }
  };

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await driver.createDbIfNotExists();
    // From here on the driver writes at DEBUG into a counting writer: every statement line is
    // written while the errors under test are made, and none of it reaches the console.
    driverLogger = internals.logger;
    internals.logger = new Logger({
      name: 'SpannerDriver',
      logLevel: 'debug',
      logWriter: { write: () => (linesWritten += 1) } as any,
    });
    await dropTables();
    await driver.runUpdateSchema([
      `CREATE TABLE ${TABLE} (id STRING(MAX) NOT NULL, n STRING(MAX)) PRIMARY KEY (id)`,
      `CREATE TABLE ${DUPES} (id STRING(MAX) NOT NULL, v STRING(MAX)) PRIMARY KEY (id)`,
    ]);
    await driver.runDml(insert(KEY, '10'));
    await driver.runDml(insert('identity-row-2', 'not a number'));
    for (const id of ['dupe-1', 'dupe-2']) {
      await driver.runDml(() => ({
        sql: `INSERT INTO \`${DUPES}\` (\`id\`, \`v\`) VALUES (@id, @v)`,
        namedParams: { params: { id, v: 'the same' }, types: { id: 'string', v: 'string' } },
      }));
    }
  }, 120000);

  afterAll(async () => {
    await dropTables();
    internals.logger = driverLogger;
    await SpannerEmulatorProvisioner.release();
    if (RECORD_TO) {
      const recording: Recording = {
        source: process.env.THROWN_ERROR_IDENTITY_SOURCE ?? 'the release line',
        clientLibrary: CLIENT_LIBRARY_VERSION,
        doors: observed['the values switch closed'],
      };
      fs.writeFileSync(RECORD_TO, `${JSON.stringify(recording, null, 2)}\n`);
    }
  }, 120000);

  const GATES: [string, { [name: string]: string }][] = [
    ['the values switch closed', {}],
    ['the values switch open', { DEVELOPMENT: 'true', DB_LOG_PARAM_VALUES: '1' }],
  ];

  describe.each(GATES)('%s', (gate, env) => {
    const recording: Recording | undefined = RECORD_TO
      ? undefined
      : JSON.parse(fs.readFileSync(RECORDING_PATH, 'utf8'));

    beforeAll(async () => {
      const before: { [name: string]: string | undefined } = {};
      for (const name of ['DEVELOPMENT', 'DB_LOG_PARAM_VALUES']) {
        before[name] = process.env[name];
        delete process.env[name];
      }
      Object.assign(process.env, env);
      try {
        observed[gate] = await observeEveryDoor();
      } finally {
        for (const [name, value] of Object.entries(before)) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      }
    }, 240000);

    test('the premise: the recording was read through this client library, covers exactly these doors, and the lines were written', () => {
      expect(linesWritten).toBeGreaterThan(DOORS.length);
      if (!recording) {
        return;
      }
      expect(recording.clientLibrary).toBe(CLIENT_LIBRARY_VERSION);
      expect(Object.keys(recording.doors).sort()).toEqual(DOORS.map(([door]) => door).sort());
    });

    test.each(DOORS.map(([door]) => door))('%s', (door) => {
      const seen = observed[gate][door];
      expect(seen.thrown.notAnError).toBeUndefined();
      expect(seen.thrown.message).not.toMatch(/^(the door did not fail|BRAKE)/);
      if (!recording) {
        // Recording: the two passes must agree with each other, or the recording is not data.
        expect(seen).toEqual(observed[GATES[0][0]][door]);
        return;
      }
      // The premise: the backend said what it said when the recording was taken (else re-record).
      expect({ door, backendSaid: seen.backendSaid }).toEqual({ door, backendSaid: recording.doors[door].backendSaid });
      // The law: the thrown error is the release line's — and so is how often the runner ran the body.
      expect(seen.thrown).toEqual(recording.doors[door].thrown);
      expect(seen.transactionBodyRuns).toBe(recording.doors[door].transactionBodyRuns);
    });
  });
});
