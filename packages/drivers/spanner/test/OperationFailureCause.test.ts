import { Db, Record, StatementFactory, StringColumn, Table, tableByName, withRecordColumns } from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SpannerDriver, SpannerOperationError } from '@proteinjs/db-driver-spanner';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { SourceRepository } from '@proteinjs/reflection';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * A failed data op must CARRY ITS CAUSE — in what the driver throws and in what it logs. Before
 * this contract the driver logged `Failed when executing dml` with the bound VALUES and an
 * `errorDetails` field that gRPC errors rarely fill, then rethrew the vendor error whose stack
 * is the client library's own frames: an error report on that line said nothing about what
 * failed, where, or why (the 2026-09-13 ops finding — "insufficient evidence to classify without
 * the underlying cause or a stack through app code").
 *
 * The contract: the throw is a `SpannerOperationError` — the vendor error as `cause`, its gRPC
 * `code` copied (an ALREADY_EXISTS adopt-the-winner path keeps branching on `error.code === 6`),
 * the status and the statement's shape in the message, the CALLER's frames as the stack — and the
 * one error log line names the cause (code + status + message) and the statement shape, never
 * the bound values.
 */

interface CauseRow extends Record {
  name: string;
}

class CauseTestTable extends Table<CauseRow> {
  name = 'db_test_operation_failure_cause';
  columns = withRecordColumns<CauseRow>({
    name: new StringColumn('name'),
  });
}

const table: Table<CauseRow> = new CauseTestTable();
const getTable = (tableName: string) => (tableName === table.name ? table : tableByName(tableName));
const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};
const spannerDriver = new SpannerDriver(spannerConfig, getTable);

type DriverInternals = { logger: { error: (log: unknown) => void } };
const internals = spannerDriver as unknown as DriverInternals;

const settle = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(() => 'resolved' as const).catch((error: unknown) => error);

/** The insert that collides: the SAME primary key as an existing row, through the driver door. */
const duplicateInsert = (id: string) => (config: any) =>
  new StatementFactory<CauseRow>().insert(table.name, { id, name: 'again' } as any, config);

describe('SpannerOperationError.statementShape — the verb and table, never a value', () => {
  test.each([
    ['INSERT INTO `flow_case` (`chat`, `id`) VALUES (@param0, @param1);', { operation: 'INSERT', table: 'flow_case' }],
    ['insert into chat (id) values (@p0)', { operation: 'INSERT', table: 'chat' }],
    ['UPDATE `chat` SET `title` = @param0 WHERE `id` = @param1;', { operation: 'UPDATE', table: 'chat' }],
    ['DELETE FROM `thought` WHERE `id` = @param0;', { operation: 'DELETE', table: 'thought' }],
    ['SELECT `id`, `title` FROM `chat` WHERE `scope` = @param0 LIMIT 50', { operation: 'SELECT', table: 'chat' }],
    ['WITH x AS (SELECT 1) SELECT * FROM `topic`', { operation: 'SELECT', table: 'topic' }],
    ['SELECT 1', { operation: 'SELECT' }],
    ['', { operation: 'UNKNOWN' }],
  ])('%s', (sql, expected) => {
    expect(SpannerOperationError.statementShape(sql)).toEqual(expected);
  });

  test('summarize names the gRPC status of a coded error and falls back to the message of anything else', () => {
    expect(SpannerOperationError.summarize(Object.assign(new Error('Row already exists'), { code: 6 }))).toEqual({
      code: 6,
      status: 'ALREADY_EXISTS',
      message: 'Row already exists',
    });
    expect(SpannerOperationError.summarize(new Error('deadline'))).toEqual({ message: 'deadline' });
    expect(SpannerOperationError.summarize('boom')).toEqual({ message: 'boom' });
  });
});

describe('Data-op failures carry their cause (emulator)', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const db = new Db(spannerDriver, getTable, new TransactionContext());
  let errorLogSpy: jest.SpyInstance;

  beforeAll(async () => {
    registerTestUser();
    (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ] = [table];
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await spannerDriver.createDbIfNotExists();
    await spannerDriver.getTableManager().loadTable(table);
  }, 60000);

  afterAll(async () => {
    await dropTable(table);
    await SpannerEmulatorProvisioner.release();
    delete (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ];
    clearTestUser();
  }, 60000);

  beforeEach(() => {
    errorLogSpy = jest.spyOn(internals.logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorLogSpy.mockRestore();
  });

  test('a duplicate-key insert throws the typed error: status + statement in the message, the vendor error as cause, its code kept', async () => {
    const row = await db.insert(table, { name: 'first' });

    const outcome = await settle(spannerDriver.runDml(duplicateInsert(row.id)));

    expect(outcome).toBeInstanceOf(SpannerOperationError);
    const failure = outcome as SpannerOperationError;
    expect(failure.operation).toBe('dml');
    expect(failure.code).toBe(6);
    expect(failure.status).toBe('ALREADY_EXISTS');
    expect((failure.cause as { code?: number }).code).toBe(6);
    expect(failure.statement).toEqual({ operation: 'INSERT', table: table.name });
    expect(failure.message).toMatch(
      /^Failed when executing dml \(ALREADY_EXISTS, code 6\) on INSERT db_test_operation_failure_cause: /
    );
    // The message never carries a bound value.
    expect(failure.message).not.toContain('again');
    expect(failure.message).not.toContain(row.id);
    // The stack is the CALLER's — this file issued the statement — not the vendor client's frames.
    expect(failure.stack).toContain('OperationFailureCause.test');
    expect((failure.stack ?? '').split('\n')[1]).not.toMatch(/node_modules\/(google-gax|@grpc|@google-cloud)/);
  }, 30000);

  test('the one error log line names the cause and the statement shape and never the bound values', async () => {
    const row = await db.insert(table, { name: 'logged' });

    await settle(spannerDriver.runDml(duplicateInsert(row.id)));

    const dmlFailures = errorLogSpy.mock.calls
      .map((call) => call[0] as { message: string; error?: unknown; obj?: any })
      .filter((log) => log.message === 'Failed when executing dml');
    expect(dmlFailures).toHaveLength(1);
    const [log] = dmlFailures;
    expect(log.error).toBeInstanceOf(SpannerOperationError);
    expect(log.obj.statement).toEqual({ operation: 'INSERT', table: table.name });
    expect(log.obj.cause).toEqual(expect.objectContaining({ code: 6, status: 'ALREADY_EXISTS' }));
    expect(typeof log.obj.cause.message).toBe('string');
    // The parameters are described — a type per name, a length for strings — never quoted.
    const described = Object.values(log.obj.params as { [name: string]: { type: string; length?: number } });
    expect(described).toContainEqual({ type: 'string', length: 'again'.length });
    expect(described).toContainEqual({ type: 'string', length: row.id.length });
    expect(JSON.stringify(log.obj)).not.toContain('again');
    expect(JSON.stringify(log.obj)).not.toContain(row.id);
    expect(typeof log.obj.durationMs).toBe('number');
  }, 30000);

  test('in-transaction DML surfaces the same typed error (the explicit-transaction door)', async () => {
    const row = await db.insert(table, { name: 'txn' });

    const outcome = await settle(
      db.runTransaction(async () => {
        await spannerDriver.runDml(duplicateInsert(row.id), (db as any).transactionForDriver());
      })
    );

    expect(outcome).toBeInstanceOf(SpannerOperationError);
    expect((outcome as SpannerOperationError).code).toBe(6);
    expect((outcome as SpannerOperationError).statement).toEqual({ operation: 'INSERT', table: table.name });
  }, 30000);

  test('a failed query carries its cause the same way (SELECT shape, vendor status)', async () => {
    const outcome = await settle(
      spannerDriver.runQuery(() => ({ sql: 'SELECT `id` FROM `db_test_no_such_table` LIMIT 1' }) as any)
    );

    expect(outcome).toBeInstanceOf(SpannerOperationError);
    const failure = outcome as SpannerOperationError;
    expect(failure.operation).toBe('query');
    expect(failure.statement).toEqual({ operation: 'SELECT', table: 'db_test_no_such_table' });
    expect(typeof failure.code).toBe('number');
    expect(failure.status).toBeDefined();
    expect((failure.cause as { code?: number }).code).toBe(failure.code);
    const queryFailures = errorLogSpy.mock.calls
      .map((call) => call[0] as { message: string; obj?: any })
      .filter((log) => log.message === 'Failed when executing query');
    expect(queryFailures).toHaveLength(1);
    expect(queryFailures[0].obj.cause).toEqual(expect.objectContaining({ code: failure.code, status: failure.status }));
    expect(queryFailures[0].obj.params).toBeUndefined();
  }, 30000);
});
