import { randomBytes } from 'crypto';
import { Console } from 'console';
import { Writable } from 'stream';
import { format, inspect } from 'util';
import { Db, Record, StatementFactory, StringColumn, Table, tableByName, withRecordColumns } from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SpannerDriver, SpannerOperationError } from '@proteinjs/db-driver-spanner';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { SourceRepository } from '@proteinjs/reflection';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * A failed statement's error never PRINTS a record's values — however it is printed. The backend's
 * own words can quote the row a statement collided with: a unique index's refusal names the
 * colliding key, and on an account table that key is an address. The driver's typed error carries
 * the backend's error as `cause` for callers (the client library's transaction runner decides its
 * retries off the thrown error, so what it carries is left exactly as it is), and every printer
 * walks `cause` by default: `util.inspect`, so `console.error(error)` and the default dev log
 * writer's `{ error }` — the driver's own failure line among them.
 *
 * The contract: the printed error is the stack (the name, the message with values masked, the
 * caller's frames) and the error's own facts — operation, statement, code, status — with the cause
 * shown as withheld; the serialized error (a structured writer) carries no value either. Driven on
 * the emulator: a second row with the same address under a unique index.
 */

interface AccountRow extends Record {
  email: string;
}

class AccountTestTable extends Table<AccountRow> {
  name = 'db_test_printed_error_account';
  columns = withRecordColumns<AccountRow>({
    email: new StringColumn('email', { unique: { unique: true, indexName: 'db_test_printed_error_email_unique' } }),
  });
}

const table: Table<AccountRow> = new AccountTestTable();
const getTable = (tableName: string) => (tableName === table.name ? table : tableByName(tableName));
const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};
const spannerDriver = new SpannerDriver(spannerConfig, getTable);

const settle = <T>(promise: Promise<T>): Promise<unknown> =>
  promise.then(() => 'resolved' as const).catch((error: unknown) => error);

/** What `console.error(error)` writes in a Node process: a real Console over a captured stream. */
const consoleErrorOf = (error: unknown): string => {
  let written = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      written += String(chunk);
      done();
    },
  });
  new Console({ stdout: stream, stderr: stream }).error(error);
  return written;
};

describe('A failed statement`s error never prints a record`s values (emulator)', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const db = new Db(spannerDriver, getTable, new TransactionContext());
  // A fixture address (no real mailbox), unique per run.
  const address = `jordan.vale.${randomBytes(4).toString('hex')}@mail.example`;
  const localPart = address.slice(0, address.indexOf('@'));
  let failure: SpannerOperationError;
  const driverLines: string[] = [];

  beforeAll(async () => {
    registerTestUser();
    (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ] = [table];
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await spannerDriver.createDbIfNotExists();
    await spannerDriver.getTableManager().loadTable(table);

    await db.insert(table, { email: address });
    // The driver's own failure line, as the default dev log writer prints it (to console.error).
    const consoleError = jest.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
      driverLines.push(format(parts[0], ...parts.slice(1)));
    });
    try {
      const outcome = await settle(
        spannerDriver.runDml((config: any) =>
          new StatementFactory<AccountRow>().insert(
            table.name,
            { id: randomBytes(8).toString('hex'), email: address } as any,
            config
          )
        )
      );
      failure = outcome as SpannerOperationError;
    } finally {
      consoleError.mockRestore();
    }
  }, 60000);

  afterAll(async () => {
    await dropTable(table);
    await SpannerEmulatorProvisioner.release();
    delete (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ];
    clearTestUser();
  }, 60000);

  test('the premise: the unique index refused the second row, and the backend`s own words name the address', () => {
    expect(failure).toBeInstanceOf(SpannerOperationError);
    expect(failure.code).toBe(6);
    expect(failure.statement).toEqual({ operation: 'INSERT', table: table.name });
    // The vendor error rides for callers, unchanged: its words quote the colliding key.
    expect(String((failure.cause as Error).message)).toContain(address);
  });

  test('util.inspect prints no value — at any depth', () => {
    for (const depth of [0, 2, 5, 10, null]) {
      expect(inspect(failure, { depth }).toLowerCase()).not.toContain(localPart);
      expect(inspect({ error: failure }, { depth }).toLowerCase()).not.toContain(localPart);
    }
    expect(inspect(failure, { depth: 5, showHidden: true }).toLowerCase()).not.toContain(localPart);
  });

  test('console.error(error) prints no value', () => {
    expect(consoleErrorOf(failure).toLowerCase()).not.toContain(localPart);
  });

  test('JSON.stringify prints no value', () => {
    expect((JSON.stringify(failure) ?? '').toLowerCase()).not.toContain(localPart);
    expect(JSON.stringify({ error: failure }).toLowerCase()).not.toContain(localPart);
  });

  test('the driver`s own failure line, as the dev log writer prints it, carries no value', () => {
    const line = driverLines.find((text) => text.includes('Failed when executing dml'));
    expect(line).toBeDefined();
    expect(line!.toLowerCase()).not.toContain(localPart);
  });

  test('the printed error still says what failed and where: the status, the index, the table, the caller, the cause withheld', () => {
    const printed = inspect(failure, { depth: 5 });
    expect(printed).toContain('SpannerOperationError');
    expect(printed).toContain('ALREADY_EXISTS');
    expect(printed).toContain('db_test_printed_error_email_unique');
    expect(printed).toContain(table.name);
    expect(printed).toContain('OperationErrorPrinting.test');
    expect(printed).toMatch(/cause: '<withheld/);
  });
});
