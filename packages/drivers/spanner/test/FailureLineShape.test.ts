import * as fs from 'fs';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { Logger } from '@proteinjs/logger';
import { CapturedLog } from './util/printedLine';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';

/**
 * The SHAPE of the driver's failure lines is an interface: whoever reads a deployment's logs by
 * machine (an error-report pipeline that fills a triage card) parses `obj.cause.code`,
 * `obj.cause.status`, `obj.cause.message` and `obj.statement` off these lines. What `message`
 * HOLDS changed — the driver's sentence, never the backend's words — and its NAME must not: a
 * renamed field reads as an empty cause on every database failure, and nothing in this
 * repository would notice.
 *
 * Every line here is a REAL one: a failure provoked on the emulator, captured at the log writer,
 * and judged in its serialized form (what a structured writer sends: `JSON.stringify`), as a
 * reader meets it.
 *
 * RECORDING. `FAILURE_LINES_RECORD=<path> FAILURE_LINES_RECORDED_FROM=<sha>` also writes the
 * serialized lines to `<path>`, so a reader's own tests can run against real lines of a named
 * commit instead of hand-written ones.
 */

const spannerConfig = { projectId: 'proteinjs-test', instanceName: 'proteinjs-test', databaseName: 'test' };
const TABLE = 'db_test_failure_line_shape';
const DUPLICATES_TABLE = 'db_test_failure_line_shape_duplicates';
// A fixture value shaped like row content (not a real credential).
const VALUE = 'rst_shape_5d41402abc4b2a76b9719d911017c592';
const RECORD_TO = process.env.FAILURE_LINES_RECORD;

type SerializedLine = {
  scenario: string;
  loggerName?: string;
  logLevel: string;
  message?: string;
  obj?: any;
  error?: { name: string; message: string; stackHeader: string };
};

const settle = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(() => 'resolved' as const).catch((error: unknown) => error);

describe('the shape of the driver`s failure lines, as a reader of the logs parses them (emulator)', () => {
  const spannerDriver = new SpannerDriver(spannerConfig);
  const internals = spannerDriver as unknown as { logger: Logger };
  const recorded: SerializedLine[] = [];
  let captured: (CapturedLog & { loggerName?: string })[] = [];
  let driverLogger: Logger;
  const capturing = (name: string) =>
    new Logger({
      name,
      logLevel: 'info',
      logWriter: { write: (log: CapturedLog) => captured.push(log) } as any,
    });
  const callerLogger = capturing('ACaller');

  const quietly = async (work: () => Promise<unknown>) => {
    const quiet = jest.spyOn(internals.logger, 'error').mockImplementation(() => undefined);
    await work().catch(() => undefined);
    quiet.mockRestore();
  };

  /** The captured lines as a structured writer serializes them; kept for the recording. */
  const serialized = (scenario: string): SerializedLine[] => {
    const lines = captured.map((log): SerializedLine => {
      const error = log.error as Error | undefined;
      return JSON.parse(
        JSON.stringify({
          scenario,
          loggerName: log.loggerName,
          logLevel: log.logLevel,
          message: log.message,
          obj: log.obj,
          ...(error
            ? {
                error: {
                  name: error.name,
                  message: error.message,
                  // The stack above its frames: the text a stack opens with is the message again.
                  stackHeader: String(error.stack)
                    .split('\n')
                    .filter((each) => !/^\s+at /.test(each))
                    .join('\n'),
                },
              }
            : {}),
        })
      );
    });
    recorded.push(...lines);
    return lines;
  };

  /** The contract of `obj.cause`: exactly a numeric code, its status name, and a message of the driver's own. */
  const expectCause = (cause: unknown, code: number, status: string) => {
    expect(Object.keys(cause as object).sort()).toEqual(['code', 'message', 'status']);
    expect(cause).toEqual({ code, status, message: expect.any(String) });
    expect((cause as { message: string }).message.trim()).not.toBe('');
    expect((cause as { message: string }).message).not.toContain(VALUE.slice(0, 24));
  };

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await spannerDriver.createDbIfNotExists();
    await quietly(() => spannerDriver.runUpdateSchema(`DROP INDEX ${DUPLICATES_TABLE}_email`));
    await quietly(() => spannerDriver.runUpdateSchema(`DROP TABLE ${DUPLICATES_TABLE}`));
    await quietly(() => spannerDriver.runUpdateSchema(`DROP TABLE ${TABLE}`));
    await spannerDriver.runUpdateSchema([
      `CREATE TABLE ${TABLE} (id STRING(MAX) NOT NULL, ts TIMESTAMP) PRIMARY KEY (id)`,
      `CREATE TABLE ${DUPLICATES_TABLE} (id STRING(MAX) NOT NULL, email STRING(MAX)) PRIMARY KEY (id)`,
    ]);
    driverLogger = internals.logger;
    internals.logger = capturing('SpannerDriver');
  }, 120000);

  afterAll(async () => {
    internals.logger = driverLogger;
    await quietly(() => spannerDriver.runUpdateSchema(`DROP INDEX ${DUPLICATES_TABLE}_email`));
    await quietly(() => spannerDriver.runUpdateSchema(`DROP TABLE ${DUPLICATES_TABLE}`));
    await quietly(() => spannerDriver.runUpdateSchema(`DROP TABLE ${TABLE}`));
    await SpannerEmulatorProvisioner.release();
    if (RECORD_TO) {
      const recording = { recordedFrom: process.env.FAILURE_LINES_RECORDED_FROM ?? 'unknown', lines: recorded };
      fs.writeFileSync(RECORD_TO, `${JSON.stringify(recording, null, 1)}\n`);
    }
  }, 120000);

  beforeEach(() => {
    captured = [];
  });

  const insert = (id: string, ts: string | null) =>
    spannerDriver.runDml(() => ({
      sql: `INSERT INTO \`${TABLE}\` (\`id\`, \`ts\`) VALUES (@id, @ts)`,
      namedParams: { params: { id, ts }, types: { id: 'string', ts: 'timestamp' } },
    }));

  test('a row whose key already exists: `Failed when executing dml` carries cause {code, status, message} and the statement`s shape', async () => {
    await insert(VALUE, null);
    captured = [];

    const caught = (await settle(insert(VALUE, null))) as Error & { cause: Error };
    callerLogger.error({
      message: 'A caller`s own line about what it caught',
      error: caught,
      obj: { cause: caught.cause },
    });

    // The premise: the backend names the key it refused (the typed error masks it, the vendor error under it does not).
    expect(String(caught.cause.message)).toContain(VALUE.slice(0, 24));
    const lines = serialized('a row whose key already exists');
    const [failure] = lines.filter((line) => line.message === 'Failed when executing dml');
    expectCause(failure.obj.cause, 6, 'ALREADY_EXISTS');
    expect(failure.obj.statement).toEqual({ operation: 'INSERT', table: TABLE });
    expect(typeof failure.obj.sql).toBe('string');
    expect(failure.error?.message).toBe(
      `Failed when executing dml (ALREADY_EXISTS, code 6) on INSERT ${TABLE}: ${failure.obj.cause.message}`
    );
    expect(JSON.stringify(lines)).not.toContain(VALUE.slice(0, 24));
  }, 30000);

  test('a value the backend echoes bare: the same shape, the driver`s sentence as the message', async () => {
    const caught = await settle(insert('shape-row', VALUE));
    callerLogger.error({ message: 'A caller`s own line about what it caught', error: caught });

    const lines = serialized('a value the backend echoes bare');
    const [failure] = lines.filter((line) => line.message === 'Failed when executing dml');
    expectCause(failure.obj.cause, 9, 'FAILED_PRECONDITION');
    expect(failure.obj.cause.message).toBe('the statement cannot run against the database as it stands');
    expect(JSON.stringify(lines)).not.toContain(VALUE.slice(0, 24));
  }, 30000);

  test('a query that fails at runtime: `Failed when executing query`, the same shape', async () => {
    const caught = await settle(
      spannerDriver.runQuery(() => ({
        sql: 'SELECT CAST(@p AS INT64) AS v',
        namedParams: { params: { p: VALUE }, types: { p: 'string' } },
      }))
    );

    expect(caught).toBeInstanceOf(Error);
    const lines = serialized('a query that fails at runtime');
    const [failure] = lines.filter((line) => line.message === 'Failed when executing query');
    expectCause(failure.obj.cause, 11, 'OUT_OF_RANGE');
    expect(failure.obj.statement).toEqual({ operation: 'SELECT' });
    expect(JSON.stringify(lines)).not.toContain(VALUE.slice(0, 24));
  }, 30000);

  test('a schema update that fails on row data: `cause` in the same shape — the line carries no `errorDetails`', async () => {
    await spannerDriver.runDml(() => ({
      sql: `INSERT INTO \`${DUPLICATES_TABLE}\` (\`id\`, \`email\`) VALUES (@a, @email), (@b, @email)`,
      namedParams: {
        params: { a: 'dup-a', b: 'dup-b', email: VALUE },
        types: { a: 'string', b: 'string', email: 'string' },
      },
    }));
    captured = [];

    const caught = await settle(
      spannerDriver.runUpdateSchema(`CREATE UNIQUE INDEX ${DUPLICATES_TABLE}_email ON ${DUPLICATES_TABLE} (email)`)
    );

    expect(String((caught as Error).message)).toContain(VALUE.slice(0, 24));
    const lines = serialized('a schema update that fails on row data');
    const [failure] = lines.filter((line) => line.message === 'Failed when executing schema update');
    expect(Object.keys(failure.obj).sort()).toEqual(['cause', 'durationMs', 'statements']);
    expect(failure.obj.cause).toEqual({
      code: expect.any(Number),
      status: expect.any(String),
      message: expect.any(String),
    });
    expect(failure.obj.cause.message.trim()).not.toBe('');
    expect(JSON.stringify(lines)).not.toContain(VALUE.slice(0, 24));
  }, 60000);
});
