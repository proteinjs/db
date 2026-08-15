import { IntegerColumn, Record, StringColumn, Table, TableChanges, withRecordColumns } from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * The concurrent-schema-reconcile race (closed by TableManager.reconcileConcurrentSchemaChange +
 * SpannerSchemaOperations.isAlreadyExistsError).
 *
 * On a schema-changing release the migration Job, booting pods, and multiple replicas all run
 * Db.init -> loadTables at once. loadTable/loadTables is check-then-act: two actors both observe a
 * column/table as absent and both issue the CREATE/ALTER; Spanner serializes the DDL so the object
 * lands EXACTLY once, and the loser's operation fails with a duplicate-name / duplicate-column
 * error. Before the fix the loser rethrew — a booting pod exited (CrashLoopBackOff) and the
 * migration Job exited 1 (a spurious migration-gate failure).
 *
 * The tolerance is not a blanket swallow: it fires only for the already-exists error CLASS and only
 * after RE-READING the live schema and confirming it matches the INTENDED definition.
 */

const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};

const spannerDriver = new SpannerDriver(spannerConfig);

interface ReconcileRow extends Record {
  name?: string;
}

interface GrownRow extends ReconcileRow {
  nickname?: string;
}

/** Base table, `name` only — the pre-change schema. */
const baseTable = (): Table<ReconcileRow> =>
  new (class extends Table<ReconcileRow> {
    name = 'db_test_reconcile';
    columns = withRecordColumns<ReconcileRow>({
      name: new StringColumn('name'),
    });
  })();

/** Same table redeclared with an added `nickname` column — the alter under contention. */
const grownTable = (): Table<GrownRow> =>
  new (class extends Table<GrownRow> {
    name = 'db_test_reconcile';
    columns = withRecordColumns<GrownRow>({
      name: new StringColumn('name'),
      nickname: new StringColumn('nickname'),
    });
  })();

interface ConflictRow extends Record {
  qty?: any;
}

/** `qty` declared as a STRING — the definition the "winner" lands. */
const conflictStringTable = (): Table<ConflictRow> =>
  new (class extends Table<ConflictRow> {
    name = 'db_test_reconcile_conflict';
    columns = withRecordColumns<ConflictRow>({
      qty: new StringColumn('qty'),
    });
  })();

/** Same table+column redeclared as INT64 — a GENUINE conflict with what landed. */
const conflictIntegerTable = (): Table<ConflictRow> =>
  new (class extends Table<ConflictRow> {
    name = 'db_test_reconcile_conflict';
    columns = withRecordColumns<ConflictRow>({
      qty: new IntegerColumn('qty'),
    });
  })();

interface TableManagerInternals {
  getTableChanges(table: Table<any>): Promise<TableChanges>;
  reconcileConcurrentSchemaChange(tables: Table<any>[], error: unknown): Promise<void>;
}

type SpannerTableManager = ReturnType<SpannerDriver['getTableManager']>;

/** House-style access to reconcile internals: a typed cast on the instance, not a public method. */
const internals = (tableManager: SpannerTableManager) => tableManager as unknown as TableManagerInternals;

/** House-style access to the driver-specific classifier. */
const classifier = (tableManager: SpannerTableManager) =>
  tableManager.schemaOperations as unknown as { isAlreadyExistsError(error: unknown): boolean };

describe('Concurrent schema reconcile', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const tableManager = spannerDriver.getTableManager();

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
  }, 60000);

  beforeEach(async () => {
    await dropTable(baseTable());
    await dropTable(conflictStringTable());
  }, 60000);

  afterAll(async () => {
    await dropTable(baseTable());
    await dropTable(conflictStringTable());
    SpannerEmulatorProvisioner.release();
  }, 60000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('two actors adding the SAME new column both succeed; the column lands once with the intended type', async () => {
    // Winner: create the base table, then add `nickname` for real.
    await tableManager.loadTable(baseTable());
    await tableManager.loadTable(grownTable());

    // Loser: a second reconciler whose PLANNING read is forced stale (nickname still absent), so it
    // issues the real `ALTER TABLE ... ADD COLUMN nickname` that the backend rejects as a
    // duplicate. mockImplementationOnce affects ONLY the planning read; the reconcile's own
    // verification re-read sees the true (post-winner) schema.
    const loserTm = spannerDriver.getTableManager();
    const realGetColumnMetadata = loserTm.schemaMetadata.getColumnMetadata.bind(loserTm.schemaMetadata);
    jest.spyOn(loserTm.schemaMetadata, 'getColumnMetadata').mockImplementationOnce(async (table) => {
      const columnMetadata = await realGetColumnMetadata(table);
      delete columnMetadata['nickname'];
      return columnMetadata;
    });

    // OUTCOME: the loser's Db.init-equivalent does NOT reject — the duplicate DDL error is
    // reconciled to success. (Pre-fix, this rejects with "Duplicate column name" — the red run.)
    await expect(loserTm.loadTable(grownTable())).resolves.toBeUndefined();

    // The column exists exactly once, with the intended type (StringColumn defaults to STRING(255)).
    const columnMetadata = await tableManager.schemaMetadata.getColumnMetadata(grownTable());
    expect(columnMetadata['nickname']).toBeDefined();
    expect(columnMetadata['nickname'].type).toBe('STRING(255)');

    // And the reconciled schema is truly up to date: a clean pass issues ZERO DDL.
    const runUpdateSchemaSpy = jest.spyOn(spannerDriver, 'runUpdateSchema');
    await tableManager.loadTable(grownTable());
    expect(runUpdateSchemaSpy).not.toHaveBeenCalled();
  }, 60000);

  test('two actors creating the SAME absent table both succeed; the table lands once', async () => {
    // Winner: create the table for real.
    await tableManager.loadTable(baseTable());

    // Loser: a second reconciler forced to see the table as ABSENT at planning, so it issues the
    // real `CREATE TABLE` that the backend rejects as a duplicate name.
    const loserTm = spannerDriver.getTableManager();
    jest.spyOn(loserTm.schemaMetadata, 'tableExists').mockImplementationOnce(async () => false);

    // OUTCOME: the loser's create does NOT reject. (Pre-fix, this rejects with "Duplicate name in
    // schema" — the red run.)
    await expect(loserTm.loadTable(baseTable())).resolves.toBeUndefined();

    expect(await tableManager.tableExists(baseTable())).toBe(true);
  }, 60000);

  test('GENUINE CONFLICT: an already-exists error whose live definition differs from intent STILL throws', async () => {
    // Winner landed `qty` as STRING(MAX).
    await tableManager.loadTable(conflictStringTable());

    // Produce a REAL duplicate-column error by adding `qty` again as INT64 (a loser intending a
    // different type). It IS the already-exists class...
    let duplicateError: unknown;
    try {
      await spannerDriver.runUpdateSchema('ALTER TABLE `db_test_reconcile_conflict` ADD COLUMN `qty` INT64');
    } catch (error) {
      duplicateError = error;
    }
    expect(duplicateError).toBeDefined();
    expect(classifier(tableManager).isAlreadyExistsError(duplicateError)).toBe(true);

    // ...but the live schema (qty STRING(MAX)) does NOT match the intended definition (qty INT64),
    // so reconcile must RETHROW the original error rather than mask a genuine conflict.
    // (Bite: turn reconcile into a blanket swallow and this rejection disappears.)
    await expect(
      internals(tableManager).reconcileConcurrentSchemaChange([conflictIntegerTable()], duplicateError)
    ).rejects.toBe(duplicateError);
  }, 60000);

  test('UNRELATED ERROR CLASS: a non-already-exists DDL error propagates unchanged', async () => {
    // A table that already matches the live schema — verification alone would find nothing to do.
    await tableManager.loadTable(baseTable());

    // An error from a different class (INVALID_ARGUMENT: index on a missing column).
    let unrelatedError: unknown;
    try {
      await spannerDriver.runUpdateSchema('CREATE INDEX db_test_reconcile_bad ON db_test_reconcile(no_such_col)');
    } catch (error) {
      unrelatedError = error;
    }
    expect(unrelatedError).toBeDefined();
    expect(classifier(tableManager).isAlreadyExistsError(unrelatedError)).toBe(false);

    // reconcile must NOT touch this — it is not the already-exists class, so it propagates
    // unchanged. (Bite: broaden the classifier to match every error and this rejection disappears,
    // because verification finds no pending changes on the up-to-date table and would swallow it.)
    await expect(internals(tableManager).reconcileConcurrentSchemaChange([baseTable()], unrelatedError)).rejects.toBe(
      unrelatedError
    );
  }, 60000);

  test('classifier matches ONLY the already-exists class — by code family AND message class', () => {
    const isAlreadyExists = (code: number | undefined, message: string) =>
      classifier(tableManager).isAlreadyExistsError({ code, message });

    // Matched: the duplicate/already-exists phrasings under the ALREADY_EXISTS code family {6, 9}.
    expect(isAlreadyExists(9, '9 FAILED_PRECONDITION: Duplicate column name db_test.qty.')).toBe(true);
    expect(isAlreadyExists(9, '9 FAILED_PRECONDITION: Duplicate name in schema: db_test.')).toBe(true);
    expect(isAlreadyExists(6, '6 ALREADY_EXISTS: Table db_test already exists')).toBe(true);

    // NOT matched — other code-9 (FAILED_PRECONDITION) errors that must never be swallowed.
    expect(
      isAlreadyExists(
        9,
        '9 FAILED_PRECONDITION: a concurrent schema change operation or read-write transaction is already in progress'
      )
    ).toBe(false);
    expect(isAlreadyExists(9, '9 FAILED_PRECONDITION: Index backfill failed: uniqueness violation')).toBe(false);

    // NOT matched — right message, wrong code family.
    expect(isAlreadyExists(3, '3 INVALID_ARGUMENT: Duplicate column name db_test.qty.')).toBe(false);
    expect(isAlreadyExists(5, '5 NOT_FOUND: Table not found: db_test')).toBe(false);

    // NOT matched — reconcile-layer errors are plain Errors with no `code`.
    expect(classifier(tableManager).isAlreadyExistsError(new Error('Unable to change column types in Spanner'))).toBe(
      false
    );
    expect(classifier(tableManager).isAlreadyExistsError(undefined)).toBe(false);
  });
});
