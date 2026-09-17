import { SpannerDriver, SpannerOperationError } from '@proteinjs/db-driver-spanner';

/**
 * A failed SCHEMA UPDATE must carry its cause the way a failed data op does
 * (OperationFailureCause.test.ts). Before this contract the driver logged `Failed when executing
 * schema update` with the statement list and an `errorDetails` string and NO error object — a
 * stackless line that a structured log sink titles with the bare message — and rethrew the vendor
 * error, whose stack is the client library's own frames.
 *
 * The contract: the throw is a `SpannerOperationError` — the vendor error as `cause`, its gRPC
 * `code` copied (the concurrent-reconcile path keeps classifying on `code` + message), the status
 * and the batch's shape (the first statement's verb and the object it names, the statement count)
 * in the message, the CALLER's frames as the stack — and the one error log line carries that error
 * as `error`, the cause summary (code + status + message), the statement shape and the statement
 * list (DDL carries no row values; the list plus the backend's reason locate the failing statement).
 *
 * Pure unit tests: a fake Database static rejects the way the vendor client does — validation
 * phase (`updateSchema` itself rejects with a coded gRPC error, `details` filled) and apply phase
 * (the long-running operation's `promise()` rejects, `details` undefined) — the
 * EnvTokenAuth.test.ts pattern. No emulator, no RPCs.
 */

type DriverStatics = { SPANNER_DB?: unknown; LIVENESS_MONITOR?: unknown };
const statics = SpannerDriver as unknown as DriverStatics;

type ErrorLog = { message: string; error?: unknown; obj?: any };
type DriverInternals = { logger: { error: (log: ErrorLog) => void } };

const fakeMonitor = {
  logPoolPressure: () => undefined,
  poolStats: () => ({ size: 0, available: 0, borrowed: 0, pending: 0, totalWaiters: 0 }),
  reportError: () => undefined,
  stop: () => undefined,
};

/** Validation-phase rejection: the DDL RPC itself fails with a coded gRPC error. */
const rejectingAtValidation = (error: unknown) => ({ updateSchema: () => Promise.reject(error) });

/** Apply-phase rejection: the RPC accepts the batch; the long-running operation then fails. */
const rejectingAtApply = (error: unknown) => ({
  updateSchema: () => Promise.resolve([{ promise: () => Promise.reject(error) }]),
});

const validationError = () =>
  Object.assign(new Error('Column no_such_column not found in table db_test_schema_parent'), {
    code: 9,
    details: 'Column no_such_column not found in table db_test_schema_parent',
  });

const settle = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(() => 'resolved' as const).catch((error: unknown) => error);

describe('SpannerOperationError.statementShape — DDL: the verb and the object it names, never a value', () => {
  test.each([
    [
      'CREATE TABLE `db_test_schema_parent` (id STRING(36)) PRIMARY KEY (id)',
      { operation: 'CREATE TABLE', table: 'db_test_schema_parent' },
    ],
    ['create table if not exists foo (id STRING(36)) PRIMARY KEY (id)', { operation: 'CREATE TABLE', table: 'foo' }],
    ['CREATE INDEX foo_name ON foo(name)', { operation: 'CREATE INDEX', table: 'foo_name' }],
    ['CREATE UNIQUE INDEX foo_name ON foo(name)', { operation: 'CREATE UNIQUE INDEX', table: 'foo_name' }],
    [
      'CREATE NULL_FILTERED INDEX foo_name ON foo(name)',
      { operation: 'CREATE NULL_FILTERED INDEX', table: 'foo_name' },
    ],
    ['ALTER TABLE foo ADD COLUMN bar STRING(MAX)', { operation: 'ALTER TABLE', table: 'foo' }],
    [
      'ALTER DATABASE `test` SET OPTIONS (version_retention_period = "1m")',
      { operation: 'ALTER DATABASE', table: 'test' },
    ],
    ['DROP INDEX foo_name', { operation: 'DROP INDEX', table: 'foo_name' }],
    ['DROP TABLE IF EXISTS foo', { operation: 'DROP TABLE', table: 'foo' }],
    [
      'CREATE SEQUENCE foo_seq OPTIONS (sequence_kind = "bit_reversed_positive")',
      { operation: 'CREATE SEQUENCE', table: 'foo_seq' },
    ],
    [
      'CREATE OR REPLACE VIEW foo_view SQL SECURITY INVOKER AS SELECT id FROM foo',
      { operation: 'CREATE OR REPLACE VIEW', table: 'foo_view' },
    ],
    ['CREATE CHANGE STREAM foo_stream FOR ALL', { operation: 'CREATE CHANGE STREAM', table: 'foo_stream' }],
    ['ANALYZE', { operation: 'ANALYZE' }],
  ])('%s', (sql, expected) => {
    expect(SpannerOperationError.statementShape(sql)).toEqual(expected);
  });
});

describe('Schema-update failures carry their cause', () => {
  let driver: SpannerDriver;
  let errorLogSpy: jest.SpyInstance;

  beforeEach(() => {
    driver = new SpannerDriver({ projectId: 'fake', instanceName: 'fake', databaseName: 'fake' });
    statics.LIVENESS_MONITOR = fakeMonitor;
    errorLogSpy = jest
      .spyOn((driver as unknown as DriverInternals).logger, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    statics.SPANNER_DB = undefined;
    statics.LIVENESS_MONITOR = undefined;
    jest.restoreAllMocks();
  });

  const failureLogs = (): ErrorLog[] =>
    errorLogSpy.mock.calls
      .map((call) => call[0] as ErrorLog)
      .filter((log) => log.message === 'Failed when executing schema update');

  test("the one error log line carries the typed error: status and the statement's verb and object in its message, the caller's stack", async () => {
    const statement = 'CREATE INDEX db_test_schema_bogus_index ON db_test_schema_parent(no_such_column)';
    statics.SPANNER_DB = rejectingAtValidation(validationError());

    await settle(driver.runUpdateSchema(statement));

    expect(failureLogs()).toHaveLength(1);
    const [log] = failureLogs();
    expect(log.error).toBeInstanceOf(SpannerOperationError);
    const failure = log.error as SpannerOperationError;
    expect(failure.operation).toBe('schema update');
    expect(failure.code).toBe(9);
    expect(failure.status).toBe('FAILED_PRECONDITION');
    expect(failure.statement).toEqual({
      operation: 'CREATE INDEX',
      table: 'db_test_schema_bogus_index',
      statementCount: 1,
    });
    expect(failure.message).toMatch(
      /^Failed when executing schema update \(FAILED_PRECONDITION, code 9\) on CREATE INDEX db_test_schema_bogus_index: Column no_such_column not found/
    );
    // The stack is the CALLER's — this file issued the statement — not the vendor client's frames.
    expect(failure.stack).toContain('SchemaUpdateFailureCause.test');
    // The line's structured fields: the shape, the cause summary, the list, the duration — nothing else.
    expect(log.obj).toEqual({
      statement: failure.statement,
      cause: { code: 9, status: 'FAILED_PRECONDITION', message: expect.stringContaining('no_such_column') },
      statements: [statement],
      durationMs: expect.any(Number),
    });
  });

  test('the throw is the typed error — the vendor error as cause, its code and details kept for callers that classify on them — and it IS the logged error', async () => {
    const vendor = validationError();
    statics.SPANNER_DB = rejectingAtValidation(vendor);

    const outcome = await settle(
      driver.runUpdateSchema('CREATE TABLE db_test_schema_parent (id STRING(36)) PRIMARY KEY (id)')
    );

    expect(outcome).toBeInstanceOf(SpannerOperationError);
    const failure = outcome as SpannerOperationError;
    expect(failure.cause).toBe(vendor);
    expect(failure.code).toBe(9);
    expect(failure.details).toBe(vendor.details);
    expect(failure.statement).toEqual({ operation: 'CREATE TABLE', table: 'db_test_schema_parent', statementCount: 1 });
    expect(failureLogs()[0].error).toBe(failure);
  });

  test('a batch names its first statement and its size in the message; the whole list rides the log line', async () => {
    statics.SPANNER_DB = rejectingAtValidation(validationError());
    const statements = [
      'CREATE TABLE `db_test_schema_parent` (id STRING(36), name STRING(MAX)) PRIMARY KEY (id)',
      'CREATE UNIQUE INDEX db_test_schema_parent_name ON db_test_schema_parent(name)',
      'CREATE INDEX db_test_schema_bogus_index ON db_test_schema_parent(no_such_column)',
    ];

    const outcome = (await settle(driver.runUpdateSchema(statements))) as SpannerOperationError;

    expect(outcome).toBeInstanceOf(SpannerOperationError);
    expect(outcome.statement).toEqual({ operation: 'CREATE TABLE', table: 'db_test_schema_parent', statementCount: 3 });
    expect(outcome.message).toContain(
      '(FAILED_PRECONDITION, code 9) on CREATE TABLE db_test_schema_parent (+2 more): '
    );
    expect(failureLogs()[0].obj.statements).toEqual(statements);
  });

  test('an apply-phase failure (the long-running operation rejects; no details) carries the reason from the message, a quoted key masked', async () => {
    const applyError = Object.assign(
      new Error('Found uniqueness violation in index db_test_schema_parent_name: key {name: "dup"}'),
      { code: 9 }
    );
    statics.SPANNER_DB = rejectingAtApply(applyError);

    const outcome = (await settle(
      driver.runUpdateSchema('CREATE UNIQUE INDEX db_test_schema_parent_name ON db_test_schema_parent(name)')
    )) as SpannerOperationError;

    expect(outcome).toBeInstanceOf(SpannerOperationError);
    expect(outcome.cause).toBe(applyError);
    expect(outcome.statement).toEqual({
      operation: 'CREATE UNIQUE INDEX',
      table: 'db_test_schema_parent_name',
      statementCount: 1,
    });
    expect(outcome.message).toContain('on CREATE UNIQUE INDEX db_test_schema_parent_name: Found uniqueness violation');
    // A unique-index backfill's reason quotes the duplicate KEY — a value — and it is masked.
    expect(outcome.message).not.toMatch(/dup/);
    const [log] = failureLogs();
    expect(log.error).toBe(outcome);
    expect(log.obj.cause).toEqual({
      code: 9,
      status: 'FAILED_PRECONDITION',
      message: expect.stringContaining('uniqueness violation'),
    });
    expect(JSON.stringify(log.obj)).not.toMatch(/dup/);
  });
});
