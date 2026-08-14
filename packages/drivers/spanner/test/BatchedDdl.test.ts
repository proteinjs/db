import { Database, Spanner } from '@google-cloud/spanner';
import { Logger } from '@proteinjs/logger';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { getTables, Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};

const spannerDriver = new SpannerDriver(spannerConfig);

interface BatchDdlParent extends Record {
  name?: string;
}

interface BatchDdlChild extends Record {
  label?: string;
  parentId?: string;
}

/** Parent with a declared index — its create is CREATE TABLE + CREATE INDEX. */
const parentTable = (): Table<BatchDdlParent> => {
  return new (class extends Table<BatchDdlParent> {
    name = 'db_test_batchddl_parent';
    columns = withRecordColumns<BatchDdlParent>({
      name: new StringColumn('name'),
    });
    indexes = [{ name: 'db_test_batchddl_parent_name_index', columns: ['name'] as (keyof BatchDdlParent)[] }];
  })();
};

/** Child whose FK references the parent — creation order across the two tables is load-bearing. */
const childTable = (): Table<BatchDdlChild> => {
  return new (class extends Table<BatchDdlChild> {
    name = 'db_test_batchddl_child';
    columns = withRecordColumns<BatchDdlChild>({
      label: new StringColumn('label'),
      parentId: new StringColumn('parent_id', { references: { table: 'db_test_batchddl_parent' } }),
    });
    indexes = [{ name: 'db_test_batchddl_child_label_index', columns: ['label'] as (keyof BatchDdlChild)[] }];
  })();
};

/** Parent redeclared with an extra column + extra index — the alter pass under test. */
const grownParentTable = (): Table<BatchDdlParent & { nickname?: string }> => {
  return new (class extends Table<BatchDdlParent & { nickname?: string }> {
    name = 'db_test_batchddl_parent';
    columns = withRecordColumns<BatchDdlParent & { nickname?: string }>({
      name: new StringColumn('name'),
      nickname: new StringColumn('nickname'),
    });
    indexes = [
      { name: 'db_test_batchddl_parent_name_index', columns: ['name'] as (keyof BatchDdlParent)[] },
      { name: 'db_test_batchddl_parent_nickname_index', columns: ['nickname'] as any },
    ];
  })();
};

describe('Batched DDL', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const tableManager = spannerDriver.getTableManager();

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await dropTable(childTable());
    await dropTable(parentTable());
  }, 60000);

  afterAll(async () => {
    await dropTable(childTable());
    await dropTable(parentTable());
    SpannerEmulatorProvisioner.release();
  }, 60000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a new table lands via one runUpdateSchema call (CREATE TABLE + its indexes in one batch)', async () => {
    const parent = parentTable();
    const spy = jest.spyOn(spannerDriver, 'runUpdateSchema');

    await tableManager.loadTable(parent);

    // Call-shape at the driver seam: the table's whole schema rides ONE schema-update operation.
    expect(spy).toHaveBeenCalledTimes(1);

    // Outcome: the schema actually landed (INFORMATION_SCHEMA-backed metadata).
    expect(await tableManager.tableExists(parent)).toBe(true);
    const indexes = await tableManager.schemaMetadata.getIndexes(parent);
    expect(indexes['db_test_batchddl_parent_name_index']).toEqual(['name']);

    await dropTable(parent);
  }, 60000);

  test('an alter pass (add column + add index) lands via one runUpdateSchema call', async () => {
    await tableManager.loadTable(parentTable());
    const grown = grownParentTable();
    const spy = jest.spyOn(spannerDriver, 'runUpdateSchema');

    await tableManager.loadTable(grown);

    expect(spy).toHaveBeenCalledTimes(1);

    const columnMetadata = await tableManager.schemaMetadata.getColumnMetadata(grown);
    expect(columnMetadata['nickname']).toBeDefined();
    const indexes = await tableManager.schemaMetadata.getIndexes(grown);
    expect(indexes['db_test_batchddl_parent_nickname_index']).toEqual(['nickname']);

    await dropTable(grown);
  }, 60000);

  test('parent and FK child land in one ordered batch, and the FK is live', async () => {
    const parent = parentTable();
    const child = childTable();
    const spy = jest.spyOn(spannerDriver, 'runUpdateSchema');

    // The one-LRO claim is pinned at the CLIENT seam, not just the driver seam: a
    // runUpdateSchema that quietly looped per-statement operations would still count 1 on the
    // driver spy but N here.
    const updateSchemaSpy = jest.spyOn(Database.prototype, 'updateSchema');

    await tableManager.schemaOperations.createTables([parent, child]);

    // One schema-update operation carrying the whole set: 2 CREATE TABLE + 2 CREATE INDEX,
    // parent's CREATE before the child's (the child's inline FK resolves against it in-batch).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(updateSchemaSpy).toHaveBeenCalledTimes(1);
    expect(updateSchemaSpy.mock.calls[0][0]).toHaveLength(4);
    const statements = spy.mock.calls[0][0] as string[];
    expect(Array.isArray(statements)).toBe(true);
    expect(statements).toHaveLength(4);
    const parentCreateIndex = statements.findIndex((sql) => sql.includes('CREATE TABLE `db_test_batchddl_parent`'));
    const childCreateIndex = statements.findIndex((sql) => sql.includes('CREATE TABLE `db_test_batchddl_child`'));
    expect(parentCreateIndex).toBeGreaterThanOrEqual(0);
    expect(childCreateIndex).toBeGreaterThan(parentCreateIndex);

    // Outcome: both tables live, the child's foreign key and index actually exist.
    expect(await tableManager.tableExists(parent)).toBe(true);
    expect(await tableManager.tableExists(child)).toBe(true);
    const foreignKeys = await tableManager.schemaMetadata.getForeignKeys(child);
    expect(foreignKeys['parent_id']).toEqual({
      referencedTableName: 'db_test_batchddl_parent',
      referencedColumnName: 'id',
    });
    const childIndexes = await tableManager.schemaMetadata.getIndexes(child);
    expect(childIndexes['db_test_batchddl_child_label_index']).toEqual(['label']);

    await dropTable(child);
    await dropTable(parent);
  }, 60000);

  test('a wrong-ordered batch (FK child before parent) is REJECTED by the backend — ordering is load-bearing', async () => {
    const parent = parentTable();
    const child = childTable();
    // House-style access to the statement assembler: typed cast on the instance, not a public method.
    const ops = tableManager.schemaOperations as unknown as { createTableStatements(table: Table<any>): string[] };
    const childFirst = [...ops.createTableStatements(child), ...ops.createTableStatements(parent)];

    // The child's CREATE TABLE carries an inline FK to a parent that is not yet in the
    // projected schema at its position in the batch — validation rejects the batch and NOTHING
    // applies. This is the failure our ordered assembly exists to prevent.
    await expect(spannerDriver.runUpdateSchema(childFirst)).rejects.toThrow();
    expect(await tableManager.tableExists(child)).toBe(false);
    expect(await tableManager.tableExists(parent)).toBe(false);
  }, 60000);

  test('a schema-invalid statement mid-batch rejects the WHOLE batch upfront — nothing applied (validation phase)', async () => {
    const parent = parentTable();
    const ops = tableManager.schemaOperations as unknown as { createTableStatements(table: Table<any>): string[] };
    const [createParentSql, createNameIndexSql] = ops.createTableStatements(parent);
    // Statement 2 parses but is schema-invalid (index on a column the table does not have).
    // Schema-shape errors are caught in the batch's upfront VALIDATION pass — run in order
    // against the projected schema (the error names the missing column, so statement 1's table
    // WAS in the validation context) — and reject the batch before anything applies. Strictly
    // SAFER than the old serial path, which would have left statement 1's table behind.
    const badIndexSql = 'CREATE INDEX db_test_batchddl_parent_bogus_index ON db_test_batchddl_parent(no_such_column)';

    await expect(spannerDriver.runUpdateSchema([createParentSql, badIndexSql, createNameIndexSql])).rejects.toThrow(
      /no_such_column/
    );

    expect(await tableManager.tableExists(parent)).toBe(false);
  }, 60000);

  test('a data-dependent failure mid-batch leaves EARLIER statements applied, LATER unapplied (apply phase)', async () => {
    const parent = parentTable();
    await tableManager.loadTable(parent);
    // Two rows with the same `name`: schema validation cannot see this — only the APPLY phase
    // (index backfill) can fail on it.
    const client = new Spanner({ projectId: spannerConfig.projectId });
    const database = client.instance(spannerConfig.instanceName).database(spannerConfig.databaseName);
    database.on('error', () => undefined);
    try {
      await database.table(parent.name).insert([
        { id: 'dup-1', name: 'dup', created: new Date(), updated: new Date() },
        { id: 'dup-2', name: 'dup', created: new Date(), updated: new Date() },
      ]);
    } finally {
      await database.close().catch(() => undefined);
      client.close();
    }

    const statements = [
      'CREATE INDEX db_test_batchddl_parent_pre_index ON db_test_batchddl_parent(name, id)',
      'CREATE UNIQUE INDEX db_test_batchddl_parent_dup_unique ON db_test_batchddl_parent(name)',
      'CREATE INDEX db_test_batchddl_parent_post_index ON db_test_batchddl_parent(id, name)',
    ];
    const logErrorSpy = jest.spyOn(Logger.prototype, 'error');
    await expect(spannerDriver.runUpdateSchema(statements)).rejects.toThrow(/uniqueness violation/);

    // The failure LOG must carry the backend's reason too. Apply-phase LRO errors put it in
    // `error.message` and leave `error.details` UNDEFINED — logging details alone records an
    // empty reason for exactly the failure class that leaves partial schema state behind.
    const failureLog = logErrorSpy.mock.calls.find(
      ([entry]) => entry.message === 'Failed when executing schema update'
    );
    expect(failureLog).toBeDefined();
    expect(String((failureLog![0].obj as { errorDetails?: unknown }).errorDetails)).toMatch(/uniqueness violation/);

    // Honest partial-failure semantics of the apply phase: NOT atomic. Statement 1 stays
    // applied; statement 3, ordered after the failure, is cancelled.
    const indexes = await tableManager.schemaMetadata.getIndexes(parent);
    expect(indexes['db_test_batchddl_parent_pre_index']).toEqual(['name', 'id']);
    expect(indexes['db_test_batchddl_parent_dup_unique']).toBeUndefined();
    expect(indexes['db_test_batchddl_parent_post_index']).toBeUndefined();

    await dropTable(parent);
  }, 60000);

  test('loadTables creates the whole absent set via one runUpdateSchema call; a second pass issues none', async () => {
    const registeredTables = getTables();
    // This package registers the migration table (@proteinjs/db) and the service-verbs doc table.
    expect(registeredTables.length).toBeGreaterThanOrEqual(2);
    for (const table of [...registeredTables].reverse()) {
      await dropTable(table);
    }

    const spy = jest.spyOn(spannerDriver, 'runUpdateSchema');
    await tableManager.loadTables();
    expect(spy).toHaveBeenCalledTimes(1);
    for (const table of registeredTables) {
      expect(await tableManager.tableExists(table)).toBe(true);
    }

    // Reconcile pass on an up-to-date schema issues zero DDL.
    spy.mockClear();
    await tableManager.loadTables();
    expect(spy).not.toHaveBeenCalled();
  }, 60000);

  test('createDb with ddl births a queryable database; dropDb removes it', async () => {
    const databaseName = 'batchddl-born';
    if (await spannerDriver.dbExists(databaseName)) {
      await spannerDriver.dropDb(databaseName);
    }

    await spannerDriver.createDb(databaseName, {
      ddl: [
        'CREATE TABLE born_row (id STRING(36) NOT NULL, label STRING(MAX)) PRIMARY KEY (id)',
        'CREATE INDEX born_row_label_index ON born_row(label)',
      ],
    });
    expect(await spannerDriver.dbExists(databaseName)).toBe(true);

    // Queryability check rides a dedicated client: SpannerDriver's process-wide Database handle
    // is pinned to the suite's database, and this test is about the NEW database.
    const client = new Spanner({ projectId: spannerConfig.projectId });
    const database = client.instance(spannerConfig.instanceName).database(databaseName);
    database.on('error', () => undefined);
    try {
      await database.table('born_row').insert({ id: 'r1', label: 'born' });
      const [rows] = await database.run({ sql: 'SELECT id, label FROM born_row', json: true });
      expect(rows).toEqual([{ id: 'r1', label: 'born' }]);
      const [indexRows] = await database.run({
        sql: `SELECT i.INDEX_NAME FROM INFORMATION_SCHEMA.INDEXES i WHERE i.TABLE_NAME = 'born_row' AND i.INDEX_NAME = 'born_row_label_index'`,
        json: true,
      });
      expect(indexRows).toHaveLength(1);
    } finally {
      await database.close().catch(() => undefined);
      client.close();
    }

    await spannerDriver.dropDb(databaseName);
    expect(await spannerDriver.dbExists(databaseName)).toBe(false);
  }, 60000);
});
