import { Db, QueryBuilderFactory, Record, StringColumn, Table, tableByName, withRecordColumns } from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SpannerDriver, SpannerOperationError } from '@proteinjs/db-driver-spanner';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { Logger } from '@proteinjs/logger';
import { SourceRepository } from '@proteinjs/reflection';
import { getDropTestTable } from './util/getDropTestTable';
import { CapturedLog, lineOf, printed } from './util/printedLine';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * The backend's own message never reaches a log line or a thrown error — held here against the
 * emulator's REAL messages (FailureText.test.ts holds the same contract over the message classes
 * as data, the hosted service's phrasings included).
 *
 * The backend echoes the value it choked on, and often BARE: a string bound where a TIMESTAMP,
 * INT64, FLOAT64, DATE or NUMERIC is declared comes back as `Could not parse <value> as a
 * TIMESTAMP` / `... as an integer`; a failed CAST as `Bad int64 value: <value>`; `ERROR(@p)` as
 * the value and nothing else; a unique-index backfill over duplicate rows as `duplicate key:
 * {String("<row value>")}`. Before this contract the driver printed that message with quoted,
 * braced and bracketed text masked — so each bare echo rode the error-level failure line (beside
 * `params: { p: { type: 'timestamp', length: 36 } }`, the description that exists so the value
 * need not be printed), the thrown error's message and its stack; the schema-update line printed
 * the message unmasked and rethrew the vendor error as it was.
 *
 * Every scenario captures the driver's lines at the log WRITER with the logger at debug, and
 * judges each line — and the error the caller catches — as anything that prints it would
 * (printedLine.ts). Each also asserts its PREMISE: the vendor error behind the typed error's
 * `vendorError` accessor does quote the value, so a scenario that stopped provoking the echo
 * fails rather than passing on nothing.
 */

interface CredentialRow extends Record {
  email: string;
}

class CredentialTestTable extends Table<CredentialRow> {
  name = 'db_test_backend_message_record';
  columns = withRecordColumns<CredentialRow>({
    email: new StringColumn('email'),
  });
}

const table: Table<CredentialRow> = new CredentialTestTable();
const getTable = (tableName: string) => (tableName === table.name ? table : tableByName(tableName));
const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};
const spannerDriver = new SpannerDriver(spannerConfig, getTable);
const TYPED_TABLE = 'db_test_backend_message_typed';
const DUPLICATES_TABLE = 'db_test_backend_message_duplicates';

// Fixture values shaped like the row content that must never be printed (none is a real credential).
const valueFor = (tag: string) => `rst_${tag}_5d41402abc4b2a76b9719d911017c592`;

type DriverInternals = { logger: Logger };
const internals = spannerDriver as unknown as DriverInternals;

const settle = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(() => 'resolved' as const).catch((error: unknown) => error);

describe('The backend`s message never reaches a log line or a thrown error (emulator)', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const db = new Db(spannerDriver, getTable, new TransactionContext());
  let captured: CapturedLog[] = [];
  let driverLogger: Logger;

  const dropRawTables = () =>
    spannerDriver
      .runUpdateSchema([
        `DROP INDEX ${DUPLICATES_TABLE}_email`,
        `DROP TABLE ${DUPLICATES_TABLE}`,
        `DROP TABLE ${TYPED_TABLE}`,
      ])
      .catch(() => undefined);

  beforeAll(async () => {
    registerTestUser();
    (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ] = [table];
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await spannerDriver.createDbIfNotExists();
    await spannerDriver.getTableManager().loadTable(table);
    const quiet = jest.spyOn(internals.logger, 'error').mockImplementation(() => undefined);
    for (const statement of [`DROP TABLE ${DUPLICATES_TABLE}`, `DROP TABLE ${TYPED_TABLE}`]) {
      await spannerDriver.runUpdateSchema(statement).catch(() => undefined);
    }
    quiet.mockRestore();
    await spannerDriver.runUpdateSchema([
      `CREATE TABLE ${TYPED_TABLE} (id STRING(MAX) NOT NULL, n INT64, f FLOAT64, ts TIMESTAMP, dt DATE, num NUMERIC) PRIMARY KEY (id)`,
      `CREATE TABLE ${DUPLICATES_TABLE} (id STRING(MAX) NOT NULL, email STRING(MAX)) PRIMARY KEY (id)`,
    ]);
    // From here on the driver writes at DEBUG into a capturing writer.
    driverLogger = internals.logger;
    internals.logger = new Logger({
      name: 'SpannerDriver',
      logLevel: 'debug',
      logWriter: { write: (log: CapturedLog) => captured.push(log) } as any,
    });
  }, 120000);

  afterAll(async () => {
    internals.logger = driverLogger;
    const quiet = jest.spyOn(internals.logger, 'error').mockImplementation(() => undefined);
    await dropRawTables();
    quiet.mockRestore();
    await dropTable(table);
    await SpannerEmulatorProvisioner.release();
    delete (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ];
    clearTestUser();
  }, 120000);

  beforeEach(() => {
    captured = [];
  });

  /** No captured line and no printed form of the thrown error carries the value; the vendor error does. */
  const assertNeverPrinted = (outcome: unknown, value: string, failureLine: string) => {
    expect(outcome).toBeInstanceOf(SpannerOperationError);
    const failure = outcome as SpannerOperationError;
    // The backend cuts a long echo short (`Bad int64 value: rst_cast_5d41402abc4b2a76b9719d9...`),
    // and the head of a value is as much a leak as the whole of it: every check is on the head.
    const head = value.slice(0, 24);
    expect(captured.filter((log) => log.logLevel === 'error' && log.message === failureLine)).toHaveLength(1);
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(head);
    }
    expect(printed(failure)).not.toContain(head);
    // The premise: the backend DID echo the value, and the typed error still hands it to a caller
    // that asks by name.
    expect(String((failure.vendorError as Error).message)).toContain(head);
    return failure;
  };

  const typedInsert = (params: { [name: string]: unknown }, transaction?: any) =>
    spannerDriver.runDml(
      () => ({
        sql: `INSERT INTO \`${TYPED_TABLE}\` (\`id\`, \`n\`, \`f\`, \`ts\`, \`dt\`, \`num\`) VALUES (@id, @n, @f, @ts, @dt, @num)`,
        namedParams: {
          params: { id: 'typed-row', n: null, f: null, ts: null, dt: null, num: null, ...params },
          types: { id: 'string', n: 'int64', f: 'float64', ts: 'timestamp', dt: 'date', num: 'numeric' },
        },
      }),
      transaction
    );

  test('a string in a condition on a TIMESTAMP column, through Db and the query builder: `Could not parse <value> as a TIMESTAMP`', async () => {
    const value = valueFor('condition');
    const qb = new QueryBuilderFactory()
      .getQueryBuilder(table)
      .condition({ field: 'created', operator: '>', value: value as any });

    const outcome = await settle(db.query(table, qb));

    const failure = assertNeverPrinted(outcome, value, 'Failed when executing query');
    expect(failure.failureClass).toBe('bound value does not parse');
    expect(failure.message).toBe(
      `Failed when executing query (FAILED_PRECONDITION, code 9) on SELECT ${table.name}: a bound value does not parse as the type its parameter declares`
    );
    const [line] = captured.filter((log) => log.message === 'Failed when executing query');
    expect(line.obj.cause).toEqual({
      code: 9,
      status: 'FAILED_PRECONDITION',
      failureClass: 'bound value does not parse',
      message: 'a bound value does not parse as the type its parameter declares',
    });
    // The description beside it is what locates the parameter — without its value.
    expect(Object.values(line.obj.params)).toContainEqual({ type: 'timestamp', length: value.length });
  }, 30000);

  test.each([
    ['int64', 'n'],
    ['float64', 'f'],
    ['timestamp', 'ts'],
    ['date', 'dt'],
    ['numeric', 'num'],
  ])(
    'a string bound to a %s parameter of a dml is echoed bare by the backend — and never printed',
    async (type, param) => {
      const value = valueFor(type);

      const outcome = await settle(typedInsert({ [param]: value }));

      const failure = assertNeverPrinted(outcome, value, 'Failed when executing dml');
      expect(failure.failureClass).toBe('bound value does not parse');
      expect(failure.code).toBe(9);
      const [line] = captured.filter((log) => log.message === 'Failed when executing dml');
      expect(line.obj.params[param]).toEqual({ type, length: value.length });
    },
    30000
  );

  test('the same inside a transaction', async () => {
    const value = valueFor('transaction');

    const outcome = await settle(
      spannerDriver.runTransaction(async (transaction) => {
        await typedInsert({ n: value }, transaction);
      })
    );

    const failure = assertNeverPrinted(outcome, value, 'Failed when executing dml');
    expect(failure.failureClass).toBe('bound value does not parse');
  }, 30000);

  test.each([
    ['CAST(@p AS INT64)', 'cast'],
    ['CAST(@p AS NUMERIC)', 'numeric_cast'],
    ['ERROR(@p)', 'error_function'],
  ])(
    'a runtime failure over a bound value — %s — prints nothing of the backend`s message',
    async (expression, tag) => {
      const value = valueFor(tag);
      const statement = () => ({
        sql: `SELECT ${expression} AS v`,
        namedParams: { params: { p: value }, types: { p: 'string' } },
      });

      const outside = await settle(spannerDriver.runQuery(statement));
      const failure = assertNeverPrinted(outside, value, 'Failed when executing query');
      expect(failure.code).toBe(11);
      expect(failure.message).toBe(
        'Failed when executing query (OUT_OF_RANGE, code 11) on SELECT: a value is out of range or does not convert (a cast, a parse, arithmetic, or a check over row data)'
      );

      captured = [];
      const inside = await settle(
        spannerDriver.runTransaction(async (transaction) => {
          await spannerDriver.runQuery(statement, transaction);
        })
      );
      assertNeverPrinted(inside, value, 'Failed when executing query');
    },
    30000
  );

  test('a schema update that fails on row data — a unique index over duplicate rows — logs and throws the class and the index, never the duplicate value', async () => {
    const value = valueFor('duplicate_row');
    await spannerDriver.runDml(() => ({
      sql: `INSERT INTO \`${DUPLICATES_TABLE}\` (\`id\`, \`email\`) VALUES (@a, @email), (@b, @email)`,
      namedParams: {
        params: { a: 'dup-a', b: 'dup-b', email: value },
        types: { a: 'string', b: 'string', email: 'string' },
      },
    }));
    captured = [];

    const outcome = await settle(
      spannerDriver.runUpdateSchema(`CREATE UNIQUE INDEX ${DUPLICATES_TABLE}_email ON ${DUPLICATES_TABLE} (email)`)
    );

    const failure = assertNeverPrinted(outcome, value, 'Failed when executing schema update');
    expect(failure.operation).toBe('schema update');
    expect(failure.failureClass).toBe('unique index backfill found duplicates');
    expect(failure.message).toBe(
      `Failed when executing schema update (FAILED_PRECONDITION, code 9): uniqueness violation: a unique index cannot be built over existing rows that hold duplicate keys (index ${DUPLICATES_TABLE}_email)`
    );
    const [line] = captured.filter((log) => log.message === 'Failed when executing schema update');
    expect(line.error).toBe(failure);
    expect(line.obj.cause).toEqual(failure.causeSummary());
    expect(line.obj.statements).toEqual([
      `CREATE UNIQUE INDEX ${DUPLICATES_TABLE}_email ON ${DUPLICATES_TABLE} (email)`,
    ]);
  }, 60000);
});
