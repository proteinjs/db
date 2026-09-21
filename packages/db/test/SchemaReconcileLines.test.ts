import { inspect } from 'util';
import { Logger, LogLineErrors } from '@proteinjs/logger';
import { TableManager } from '../src/schema/TableManager';
import { TableChanges } from '../src/schema/SchemaOperations';
import { Table } from '../src/Table';

/**
 * The schema-reconcile WARN lines (`TableManager.reconcileConcurrentSchemaChange`) carry the
 * error a driver rejected with — never text copied out of it.
 *
 * A backend words a schema error itself and can quote row data in it (a unique index whose
 * backfill meets duplicate rows names the duplicate key). A driver marks such an error so the
 * logger prints its status and the driver's sentence in its place (`LogLineErrors`) — which the
 * logger can only do for the error OBJECT. These lines used to interpolate the error's `details`
 * / `message` into their own message, where nothing can recognize it.
 *
 * Judged at the log WRITER, as the text a writer would print, for each of the three outcomes
 * that log: tolerated, still absent, a genuine conflict.
 */

// A fixture value shaped like row content (not a real credential).
const VALUE = 'rst_reconcile_5d41402abc4b2a76b9719d911017c592';
const SENTENCE =
  'Failed when executing schema update (ALREADY_EXISTS, code 6): what the statement creates already exists';

type CapturedLog = { logLevel: string; message?: string; obj?: any };
type ManagerInternals = {
  logger: Logger;
  reconcileConcurrentSchemaChange(tables: Table<any>[], error: unknown): Promise<void>;
  getTableChanges(table: Table<any>): Promise<TableChanges>;
  delay(ms: number): Promise<void>;
};

const noChanges = (): TableChanges =>
  ({
    columnsToCreate: [],
    columnsToRename: [],
    columnsToAlter: [],
    columnsWithForeignKeysToDrop: [],
    columnsWithUniqueConstraintsToDrop: [],
    indexesToCreate: [],
    indexesToDrop: [],
  }) as unknown as TableChanges;

/** What a driver rejects with when the backend refuses a schema change — marked, as a driver marks it. */
const backendError = () => {
  const message = `6 ALREADY_EXISTS: Duplicate name in schema: ledger_by_email. duplicate key: {String("${VALUE}")}`;
  const error = Object.assign(new Error(message), { code: 6, details: message });
  LogLineErrors.mark(error, () => ({ code: 6, sentence: SENTENCE, facts: { status: 'ALREADY_EXISTS' } }));
  return error;
};

const printedLine = (log: CapturedLog) =>
  [log.message ?? '', inspect(log.obj, { depth: 10, maxStringLength: null }), JSON.stringify(log.obj) ?? ''].join('\n');

describe('the schema-reconcile lines carry the error itself, never its text', () => {
  const table = { name: 'ledger' } as Table<any>;
  let captured: CapturedLog[];

  const managerWhere = (live: { exists: boolean; changes: TableChanges }) => {
    const manager = new TableManager(
      {} as never,
      {} as never,
      { isAlreadyExistsError: () => true } as never,
      { tableExists: async () => live.exists } as never
    );
    const internals = manager as unknown as ManagerInternals;
    internals.logger = new Logger({
      name: 'TableManager',
      logWriter: { write: (log: CapturedLog) => captured.push(log) } as never,
    });
    internals.getTableChanges = async () => live.changes;
    internals.delay = async () => undefined;
    return internals;
  };

  beforeEach(() => {
    captured = [];
  });

  const expectTheErrorNotItsText = (line: CapturedLog, error: Error) => {
    expect(error.message).toContain(VALUE);
    expect(printedLine(line)).not.toContain(VALUE);
    expect(printedLine(line)).not.toContain('Duplicate name in schema');
    expect(line.obj.error).toBeInstanceOf(Error);
    expect(line.obj.error.message).toBe(SENTENCE);
    expect(line.message).toContain('ledger');
  };

  test('tolerated: the table is there with the intended definition', async () => {
    const error = backendError();

    await managerWhere({ exists: true, changes: noChanges() }).reconcileConcurrentSchemaChange([table], error);

    expect(captured).toHaveLength(1);
    expect(captured[0].message).toContain('tolerated concurrent ALREADY_EXISTS');
    expectTheErrorNotItsText(captured[0], error);
  });

  test('still absent after every re-read: the original error is thrown as it is', async () => {
    const error = backendError();

    const thrown = await managerWhere({ exists: false, changes: noChanges() })
      .reconcileConcurrentSchemaChange([table], error)
      .catch((each: unknown) => each);

    expect(thrown).toBe(error);
    expect(captured).toHaveLength(1);
    expect(captured[0].message).toContain('still absent');
    expectTheErrorNotItsText(captured[0], error);
  });

  test('a genuine conflict: the live schema differs from the intended definition', async () => {
    const error = backendError();
    const changes = { ...noChanges(), columnsToCreate: ['email'] } as unknown as TableChanges;

    const thrown = await managerWhere({ exists: true, changes })
      .reconcileConcurrentSchemaChange([table], error)
      .catch((each: unknown) => each);

    expect(thrown).toBe(error);
    expect(captured).toHaveLength(1);
    expect(captured[0].message).toContain('genuine conflict');
    expect(captured[0].obj.remainingChanges).toEqual(changes);
    expectTheErrorNotItsText(captured[0], error);
  });
});
