import { Db, QueryBuilderFactory, Record, StringColumn, Table, tableByName, withRecordColumns } from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SpannerDriver, SpannerOperationError } from '@proteinjs/db-driver-spanner';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { Logger } from '@proteinjs/logger';
import { SourceRepository } from '@proteinjs/reflection';
import { getDropTestTable } from './util/getDropTestTable';
import { CapturedLog, lineOf } from './util/printedLine';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * The driver never PRINTS a bound parameter's value — at any level. A statement's parameters are
 * row content: a presented reset token, a password hash, an email address. Before this contract
 * the driver's debug lines (`Executing query` / `Executing dml`) carried the whole params map, so
 * a process running at LOG_LEVEL=debug wrote every bound value of every statement to its log.
 *
 * The contract: every line the driver writes about a statement — the debug line beside the op, the
 * failure line at error, the retried-abort line — carries the SQL text (placeholders only) and,
 * for the parameters, a DESCRIPTION: each parameter's name, its type and, for strings, arrays and
 * bytes, its length. One private helper (`describeParams`) owns that description, so every call
 * site — and any future one — shares it. (The dev-only switch that adds the values back is
 * LogValuesSwitch.test.ts; it is off here.)
 *
 * SCOPE, by name: this suite holds what the DRIVER prints of the parameters it was handed. The
 * vendor-echo class — the backend's own error text quoting a bound value (a colliding key: `Row
 * {String("…")} already exists`; an unparsable one: `Bad int64 value: …`) — is
 * BackendMessageNeverOnALine.test.ts: that text stays on the thrown error, where the client
 * library's transaction runner reads it, and rides no line.
 *
 * The lines are captured at the log WRITER (what actually leaves the driver), with the driver's
 * logger at debug level, and judged as the text a writer would print (printedLine.ts): the
 * message, the inspected and serialized `obj`, and the error however anything prints it.
 */

interface CredentialRow extends Record {
  email: string;
  token: string;
}

class CredentialTestTable extends Table<CredentialRow> {
  name = 'db_test_statement_param_logging';
  columns = withRecordColumns<CredentialRow>({
    email: new StringColumn('email'),
    token: new StringColumn('token'),
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

// Fixture values shaped like the row content that must never be logged (none is a real credential).
const SECRET_TOKEN = 'rst_5d41402abc4b2a76b9719d911017c592';
const SECRET_EMAIL = 'casey.rivers@mail.example';
const OTHER_EMAIL = 'robin.hale@mail.example';

type ParamDescription = { type: string; length?: number; null?: true };
type NamedParams = { params: { [name: string]: any }; types?: { [name: string]: any } };
type DriverInternals = {
  logger: Logger;
  describeParams: (namedParams?: NamedParams) => { [name: string]: ParamDescription } | undefined;
};
const internals = spannerDriver as unknown as DriverInternals;

const settle = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(() => 'resolved' as const).catch((error: unknown) => error);

describe('The driver never prints a bound value (emulator)', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const db = new Db(spannerDriver, getTable, new TransactionContext());
  let captured: CapturedLog[] = [];
  let driverLogger: Logger;

  beforeAll(async () => {
    registerTestUser();
    (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ] = [table];
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await spannerDriver.createDbIfNotExists();
    await spannerDriver.getTableManager().loadTable(table);
    // From here on the driver writes at DEBUG into a capturing writer — the level at which the
    // per-statement lines exist at all.
    driverLogger = internals.logger;
    internals.logger = new Logger({
      name: 'SpannerDriver',
      logLevel: 'debug',
      logWriter: { write: (log: CapturedLog) => captured.push(log) } as any,
    });
  }, 60000);

  afterAll(async () => {
    internals.logger = driverLogger;
    await dropTable(table);
    await SpannerEmulatorProvisioner.release();
    delete (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ];
    clearTestUser();
  }, 60000);

  beforeEach(() => {
    captured = [];
  });

  test('a failed dml: the error line names each parameter with its type and length, and carries no value it was handed', async () => {
    const row = await db.insert(table, { email: OTHER_EMAIL, token: 'first' });
    captured = [];

    // The SAME primary key again, carrying a secret-looking token: ALREADY_EXISTS at the backend.
    const outcome = await settle(
      spannerDriver.runDml(() => ({
        sql: `INSERT INTO \`${table.name}\` (\`id\`, \`email\`, \`token\`) VALUES (@id, @email, @token)`,
        namedParams: {
          params: { id: row.id, email: SECRET_EMAIL, token: SECRET_TOKEN },
          types: { id: 'string', email: 'string', token: 'string' },
        },
      }))
    );

    expect(outcome).toBeInstanceOf(SpannerOperationError);
    const failures = captured.filter((log) => log.logLevel === 'error' && log.message === 'Failed when executing dml');
    expect(failures).toHaveLength(1);
    expect(captured.some((log) => log.logLevel === 'debug' && log.message === 'Executing dml')).toBe(true);
    // No line the failed statement produced — the error line, the debug line beside the op —
    // carries the token or the address. (`row.id` is NOT asserted: the backend quotes the colliding
    // key in its own message — the vendor-echo class this suite leaves out by name; see the header.)
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(SECRET_TOKEN);
      expect(lineOf(log)).not.toContain(SECRET_EMAIL);
    }
    const [failure] = failures;
    expect(failure.obj.sql).toContain('@token');
    expect(failure.obj.params).toEqual({
      id: { type: 'string', length: row.id.length },
      email: { type: 'string', length: SECRET_EMAIL.length },
      token: { type: 'string', length: SECRET_TOKEN.length },
    });
    expect(Object.keys(failure.obj)).not.toContain('paramValues');
    const line = lineOf(failure);
    expect(line).toContain('token');
    expect(line).toContain("type: 'string'");
  }, 30000);

  test('a failed query: the error line describes the parameters the same way', async () => {
    const outcome = await settle(
      spannerDriver.runQuery(() => ({
        sql: `SELECT \`id\` FROM \`${table.name}\` WHERE \`no_such_column\` = @token AND \`email\` IN UNNEST(@emails)`,
        namedParams: {
          params: { token: SECRET_TOKEN, emails: [SECRET_EMAIL, OTHER_EMAIL] },
          // The statement factory's array type (`ParamType`) — wider than `Statement` declares.
          types: { token: 'string', emails: { type: 'array', child: { type: 'string' } } } as any,
        },
      }))
    );

    expect(outcome).toBeInstanceOf(SpannerOperationError);
    const failures = captured.filter(
      (log) => log.logLevel === 'error' && log.message === 'Failed when executing query'
    );
    expect(failures).toHaveLength(1);
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(SECRET_TOKEN);
      expect(lineOf(log)).not.toContain(SECRET_EMAIL);
      expect(lineOf(log)).not.toContain(OTHER_EMAIL);
    }
    expect(failures[0].obj.params).toEqual({
      token: { type: 'string', length: SECRET_TOKEN.length },
      emails: { type: 'array<string>', length: 2 },
    });
  }, 30000);

  test('a failed statement on a caller`s transaction: every line of the transaction is value-free', async () => {
    const outcome = await settle(
      spannerDriver.runTransaction(async (transaction) => {
        await spannerDriver.runQuery(
          () => ({
            sql: `SELECT \`id\` FROM \`${table.name}\` WHERE \`token\` = @token`,
            namedParams: { params: { token: SECRET_TOKEN }, types: { token: 'string' } },
          }),
          transaction
        );
        return await spannerDriver.runDml(
          () => ({
            sql: `UPDATE \`${table.name}\` SET \`no_such_column\` = @email WHERE \`token\` = @token`,
            namedParams: {
              params: { email: SECRET_EMAIL, token: SECRET_TOKEN },
              types: { email: 'string', token: 'string' },
            },
          }),
          transaction
        );
      })
    );

    expect(outcome).toBeInstanceOf(SpannerOperationError);
    expect(captured.filter((log) => log.message === 'Failed when executing dml')).toHaveLength(1);
    expect(captured.filter((log) => log.message === 'Executing query')).toHaveLength(1);
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(SECRET_TOKEN);
      expect(lineOf(log)).not.toContain(SECRET_EMAIL);
    }
  }, 30000);

  test('at debug level a successful dml line describes its parameters and carries no value', async () => {
    await db.insert(table, { email: SECRET_EMAIL, token: SECRET_TOKEN });

    const dmlLines = captured.filter((log) => log.logLevel === 'debug' && log.message === 'Executing dml');
    expect(dmlLines).toHaveLength(1);
    expect(captured.length).toBeGreaterThan(1);
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(SECRET_TOKEN);
      expect(lineOf(log)).not.toContain(SECRET_EMAIL);
    }
    const described = Object.values(dmlLines[0].obj.params as { [name: string]: ParamDescription });
    expect(described).toContainEqual({ type: 'string', length: SECRET_TOKEN.length });
    expect(described).toContainEqual({ type: 'string', length: SECRET_EMAIL.length });
  }, 30000);

  test('at debug level a successful query line describes its parameters — scalar and array — and carries no value', async () => {
    await db.insert(table, { email: SECRET_EMAIL, token: SECRET_TOKEN });
    captured = [];

    const qb = new QueryBuilderFactory()
      .getQueryBuilder(table)
      .condition({ field: 'token', operator: '=', value: SECRET_TOKEN })
      .condition({ field: 'email', operator: 'IN', value: [SECRET_EMAIL, OTHER_EMAIL] });
    const rows = await db.query(table, qb);

    expect(rows.length).toBeGreaterThan(0);
    const queryLines = captured.filter((log) => log.logLevel === 'debug' && log.message === 'Executing query');
    expect(queryLines).toHaveLength(1);
    for (const log of captured) {
      expect(lineOf(log)).not.toContain(SECRET_TOKEN);
      expect(lineOf(log)).not.toContain(SECRET_EMAIL);
      expect(lineOf(log)).not.toContain(OTHER_EMAIL);
    }
    const described = Object.values(queryLines[0].obj.params as { [name: string]: ParamDescription });
    expect(described).toContainEqual({ type: 'string', length: SECRET_TOKEN.length });
    expect(described).toContainEqual({ type: 'array<string>', length: 2 });
  }, 30000);
});

describe('describeParams — names, types and lengths; never a value', () => {
  test('a typed statement: the declared type, a length for strings and arrays, null named as null', () => {
    const described = internals.describeParams({
      params: {
        token: SECRET_TOKEN,
        emails: [SECRET_EMAIL, OTHER_EMAIL],
        attempts: 3,
        score: 0.5,
        active: true,
        settings: { theme: SECRET_TOKEN },
        expires: new Date(0),
        cleared: null,
        missing: undefined,
      },
      types: {
        token: 'string',
        emails: { type: 'array', child: { type: 'string' } },
        attempts: 'int64',
        score: 'float64',
        active: 'bool',
        settings: 'json',
        expires: 'timestamp',
        cleared: 'string',
        missing: 'string',
      },
    });

    expect(described).toEqual({
      token: { type: 'string', length: SECRET_TOKEN.length },
      emails: { type: 'array<string>', length: 2 },
      attempts: { type: 'int64' },
      score: { type: 'float64' },
      active: { type: 'bool' },
      settings: { type: 'json' },
      expires: { type: 'timestamp' },
      cleared: { type: 'string', null: true },
      missing: { type: 'string', null: true },
    });
    expect(JSON.stringify(described)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(described)).not.toContain(SECRET_EMAIL);
  });

  test('an untyped statement (no types map): the type is the kind of the value, still never the value', () => {
    const described = internals.describeParams({
      params: {
        token: SECRET_TOKEN,
        emails: [SECRET_EMAIL],
        attempts: 3,
        active: false,
        expires: new Date(0),
        bytes: Buffer.from(SECRET_TOKEN),
        settings: { theme: SECRET_TOKEN },
        cleared: null,
      },
    });

    expect(described).toEqual({
      token: { type: 'string', length: SECRET_TOKEN.length },
      emails: { type: 'array', length: 1 },
      attempts: { type: 'number' },
      active: { type: 'boolean' },
      expires: { type: 'date' },
      bytes: { type: 'bytes', length: Buffer.from(SECRET_TOKEN).length },
      settings: { type: 'object' },
      cleared: { type: 'null', null: true },
    });
    expect(JSON.stringify(described)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(described)).not.toContain(SECRET_EMAIL);
  });

  test('a statement with no parameters describes nothing', () => {
    expect(internals.describeParams(undefined)).toBeUndefined();
  });
});
