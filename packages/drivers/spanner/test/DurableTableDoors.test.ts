import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { Db, getTables, isTable, QueryBuilderFactory, Table, tableByName } from '@proteinjs/db';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import { DeletableLedgerEntryTable, DurableLedgerEntryTable, LedgerEntry } from './util/durableTableDoorsTestTables';
import '../generated/test/index';

/**
 * A DURABLE table's rows survive every caller's delete, on real Spanner: the DbService door (the
 * RPC every record surface rides) and a caller-context `Db` both refuse with the typed 403 that
 * names the table, and the rows are still there afterwards. A table with the same doors that does
 * not declare it deletes exactly as before. The platform's own system-context code stays outside
 * the doors (the declared boundary: a lifecycle the platform itself runs, e.g. an account's erasure).
 *
 * The house's rule: the migration ledger's rows could be selected and deleted from the record
 * table in a deployment — they are durable records.
 */

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

describe('a durable table keeps its rows through every caller door', () => {
  const durableTable = new DurableLedgerEntryTable() as Table<LedgerEntry>;
  const deletableTable = new DeletableLedgerEntryTable() as Table<LedgerEntry>;
  const dropTable = getDropTestTable(spannerDriver);
  // Service-singleton shaped: one shared caller-context instance, default table resolution.
  const db = new Db<LedgerEntry>(spannerDriver, undefined, new TransactionContext());
  const systemDb = new Db<LedgerEntry>(spannerDriver, undefined, new TransactionContext(), true);

  /** The wire forms the Serializer produces for DbService args: `Table` crosses as its name. */
  const overWire = (args: any[]) =>
    args.map((arg) => (isTable(arg) ? tableByName((arg as Table<any>).name) : JSON.parse(JSON.stringify(arg))));

  /** Invoke like ServiceExecutor does: deserialize wire args, run the canAccess gate, call the method. */
  const rpc = async (methodName: string, args: any[]) => {
    const wireArgs = overWire(args);
    if (!db.serviceMetadata!.auth!.canAccess!(methodName, wireArgs)) {
      throw new Error(`User not authorized to run service: DbService.${methodName}`);
    }
    return await (db as any)[methodName](...wireArgs);
  };

  /** What a refused call threw, read by shape (the router reads a `ServiceRefusal` the same way). */
  const refusalOf = async (act: () => Promise<unknown>) => {
    try {
      await act();
    } catch (error: any) {
      return { name: error?.name, status: error?.status, message: error?.message };
    }
    return undefined;
  };

  const durableRefusal = {
    name: 'ServiceRefusal',
    status: 403,
    message: 'Table db_test_durable_ledger_entry is durable: its rows are never deleted',
  };

  const titles = async (table: Table<LedgerEntry>) => (await systemDb.query(table, {})).map((row) => row.title).sort();

  beforeAll(async () => {
    // An admin identity: break-glass passes every declared door — the durable delete door is the
    // one it must not pass.
    registerTestUser(['admin']);
    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    for (const table of [durableTable, deletableTable]) {
      await dropTable(table);
      await spannerDriver.getTableManager().loadTable(table);
    }
    // A delete that goes through reads every table that can hold a reference to the deleted rows
    // — any registered dynamic reference column can point at any table (the reverse-cascade
    // edges): those tables must exist, fresh emulator or not.
    const holdsDynamicReference = (table: Table<any>) =>
      Object.values(table.columns).some((column: any) => typeof column?.dynamicRefTableColName === 'string');
    for (const table of getTables().filter(holdsDynamicReference)) {
      await spannerDriver.getTableManager().loadTable(table);
    }
  }, 120000);

  afterAll(async () => {
    clearTestUser();
    for (const table of [durableTable, deletableTable]) {
      await dropTable(table);
    }
    await SpannerEmulatorProvisioner.release();
  }, 30000);

  test('the DbService door refuses the delete with the typed 403 naming the table; the row stays', async () => {
    const entry = await db.insert(durableTable, { title: 'run-1' });

    expect(await refusalOf(() => rpc('delete', [durableTable, { id: entry.id }]))).toEqual(durableRefusal);

    expect(await titles(durableTable)).toEqual(['run-1']);
  });

  test('a caller-context Db refuses too — by id and by a query over every row; every row stays', async () => {
    await db.insert(durableTable, { title: 'run-2' });
    const before = await titles(durableTable);

    const [first] = await systemDb.query(durableTable, {});
    expect(await refusalOf(() => db.delete(durableTable, { id: first.id }))).toEqual(durableRefusal);
    const everyRow = new QueryBuilderFactory().getQueryBuilder(durableTable);
    expect(await refusalOf(() => db.delete(durableTable, everyRow))).toEqual(durableRefusal);

    expect(await titles(durableTable)).toEqual(before);
  });

  test('a table with the same doors that does not declare it deletes exactly as before', async () => {
    const kept = await db.insert(deletableTable, { title: 'kept' });
    const gone = await db.insert(deletableTable, { title: 'gone' });

    expect(await rpc('delete', [deletableTable, { id: gone.id }])).toBe(1);
    expect(await db.delete(deletableTable, { id: kept.id })).toBe(1);

    expect(await titles(deletableTable)).toEqual([]);
  });

  test('the platform’s own system-context code stays outside the doors (the declared boundary)', async () => {
    const entry = await systemDb.insert(durableTable, { title: 'erased-by-a-platform-lifecycle' });

    expect(await systemDb.delete(durableTable, { id: entry.id })).toBe(1);

    expect(await titles(durableTable)).not.toContain('erased-by-a-platform-lifecycle');
  });
});
