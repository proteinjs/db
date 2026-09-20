import { inspect } from 'util';
import knex from 'knex';
import { Record, StringColumn, Table, TableChanges, withRecordColumns } from '@proteinjs/db';
import { KnexDriver, KnexOperationError } from '@proteinjs/db-driver-knex';
import { Logger } from '@proteinjs/logger';

/**
 * The vendor's own text never reaches a log line or a thrown error — on EVERY door of the driver,
 * not only a data statement's. The client library's message quotes what it choked on: a unique
 * index built over duplicate rows fails with `Duplicate entry '<row value>' for key '…'`, and the
 * query layer prefixes the failed SQL. Before this contract a schema operation rejected with a
 * string carrying that reason verbatim (`Failed to alter table: t. reason: Error: … Duplicate
 * entry '<row value>' …`), and the database-level statements (create / drop / list) rethrew the
 * vendor error as it was.
 *
 * The contract: every rejection leaves the driver as a `KnexOperationError` — what failed in the
 * driver's words plus the vendor's CODES, each kept only in its constant form — with the vendor
 * error behind the `vendorError` accessor: not `cause`, not a property of the instance, and not
 * in any rendering of the error, whatever the inspection options.
 *
 * No server is needed: the REAL query layer and dialect run over a stub connection that rejects
 * the way the client library does.
 */

// A fixture value shaped like the row content that must never be printed (not a real credential).
const VALUE = 'rst_5d41402abc4b2a76b9719d911017c592';

type DriverInternals = { logger: Logger };
type DriverStatics = { KNEX?: unknown };
type CapturedLog = { logLevel: string; message?: string; obj?: any; error?: any };

/** An error as anything that prints errors would print it (every inspection option included). */
const printed = (error: any): string => {
  const parts = [
    String(error?.message ?? error),
    String(error?.stack),
    inspect({ error }, { depth: 10, maxStringLength: null }),
    inspect(error, { depth: 10, maxStringLength: null, showHidden: true, getters: true }),
    JSON.stringify(error) ?? '',
  ];
  for (let link = error?.cause, depth = 0; link && depth < 5; link = link.cause, depth++) {
    parts.push(String(link.message), inspect(link, { depth: 10 }));
  }
  if (error && typeof error === 'object') {
    for (const name of Object.getOwnPropertyNames(error)) {
      parts.push(inspect(error[name], { depth: 10, maxStringLength: null }));
    }
  }
  return parts.join('\n');
};

const lineOf = (log: CapturedLog): string =>
  [log.logLevel, log.message ?? '', inspect(log.obj, { depth: 10 }), log.error ? printed(log.error) : ''].join('\n');

/** A connection that rejects every statement like a duplicate entry whose text quotes VALUE. */
const rejectingConnection = () => ({
  state: 'authenticated',
  on: () => undefined,
  removeAllListeners: () => undefined,
  connect: (done: (error?: Error) => void) => done(),
  end: (done: (error?: Error) => void) => done(),
  query: (options: { sql: string }, _bindings: any[], done: (error: Error) => void) => {
    const sqlMessage = `Duplicate entry '${VALUE}' for key 'credential_email'`;
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

interface CredentialRow extends Record {
  email: string;
}

class CredentialTable extends Table<CredentialRow> {
  name = 'credential';
  columns = withRecordColumns<CredentialRow>({
    email: new StringColumn('email'),
  });
}

const noChanges = (): TableChanges => ({
  columnsToCreate: [],
  columnsToRename: [],
  columnsToAlter: [],
  columnTypeChanges: [],
  columnNullableChanges: [],
  columnsWithForeignKeysToCreate: [],
  foreignKeysToCreate: [],
  columnsWithForeignKeysToDrop: [],
  foreignKeysToDrop: [],
  columnsWithUniqueConstraintsToCreate: [],
  columnsWithUniqueConstraintsToDrop: [],
  indexesToCreate: [],
  indexesToDrop: [],
});

describe('The vendor`s text never leaves the driver — schema operations and database statements included', () => {
  const driver = new KnexDriver({ host: 'localhost', user: 'root', password: '', dbName: 'test' });
  const internals = driver as unknown as DriverInternals;
  const statics = KnexDriver as unknown as DriverStatics;
  const table = new CredentialTable();
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
  });

  const settle = (promise: Promise<unknown>): Promise<any> =>
    promise.then(
      () => 'resolved',
      (error: unknown) => error
    );

  const assertTyped = (outcome: any, message: string) => {
    expect(printed(outcome)).not.toContain(VALUE);
    expect(outcome).toBeInstanceOf(KnexOperationError);
    expect(outcome.message).toBe(message);
    expect(outcome.code).toBe('ER_DUP_ENTRY');
    expect(outcome.errno).toBe(1062);
    // The premise, and the one door left open: the vendor error quotes the value, for a caller that asks by name.
    expect(outcome.vendorError.sqlMessage).toContain(VALUE);
    expect(Object.getOwnPropertyNames(outcome)).not.toContain('vendorError');
    expect('cause' in outcome).toBe(false);
  };

  test('a unique index over duplicate rows (alterTable): the throw names the table and the codes, never the duplicate row value', async () => {
    const changes = {
      ...noChanges(),
      indexesToCreate: [{ name: 'credential_email', columns: ['email'], unique: true }],
    };

    const outcome = await settle(driver.getTableManager().schemaOperations.alterTable(table, changes as TableChanges));

    assertTyped(outcome, 'Failed to alter table: credential (ER_DUP_ENTRY, errno 1062)');
  });

  test('createTables fails the same way', async () => {
    const outcome = await settle(driver.getTableManager().schemaOperations.createTables([table]));

    assertTyped(outcome, 'Failed to create table: credential (ER_DUP_ENTRY, errno 1062)');
  });

  test.each([
    ['createDb', () => driver.createDb('scratch'), 'CREATE DATABASE scratch;'],
    ['dropDb', () => driver.dropDb('scratch'), 'DROP DATABASE scratch;'],
    ['dbExists', () => driver.dbExists('scratch'), 'SHOW DATABASES;'],
  ])(
    'a database-level statement (%s) rides the statement door: one described error line, the typed throw',
    async (_name, run, sql) => {
      const outcome = await settle(run());

      assertTyped(outcome, 'Failed when executing sql (ER_DUP_ENTRY, errno 1062)');
      const failures = captured.filter(
        (log) => log.logLevel === 'error' && log.message === 'Failed when executing sql'
      );
      expect(failures).toHaveLength(1);
      expect(failures[0].obj).toEqual({
        sql,
        params: undefined,
        cause: { name: 'Error', code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000' },
      });
      for (const log of captured) {
        expect(lineOf(log)).not.toContain(VALUE);
      }
    }
  );

  test('a vendor field is kept only in its constant form: free text in `code`, `name` or `sqlState` is dropped', () => {
    const failure = new KnexOperationError(
      Object.assign(new Error('boom'), {
        name: `Error ${VALUE}`,
        code: `bad value ${VALUE}`,
        errno: 1062,
        sqlState: VALUE,
      })
    );

    expect(failure.causeSummary()).toEqual({ errno: 1062 });
    expect(failure.message).toBe('Failed when executing sql (errno 1062)');
    expect(printed(failure)).not.toContain(VALUE);
  });
});
