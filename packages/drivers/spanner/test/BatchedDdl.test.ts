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

    await tableManager.schemaOperations.createTables([parent, child]);

    // One schema-update operation carrying the whole set: 2 CREATE TABLE + 2 CREATE INDEX,
    // parent's CREATE before the child's (the child's inline FK resolves against it in-batch).
    expect(spy).toHaveBeenCalledTimes(1);
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
});
