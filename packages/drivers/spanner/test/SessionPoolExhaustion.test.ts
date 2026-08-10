import { Database, SessionPool } from '@google-cloud/spanner';
import { Db, Record, StringColumn, Table, tableByName, withRecordColumns } from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { SourceRepository } from '@proteinjs/reflection';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

interface WedgeEmployee extends Record {
  name: string;
  department?: string;
}

class WedgeEmployeeTestTable extends Table<WedgeEmployee> {
  name = 'db_test_pool_wedge_employee';
  columns = withRecordColumns<WedgeEmployee>({
    name: new StringColumn('name'),
    department: new StringColumn('department'),
  });
}

const employeeTable: Table<WedgeEmployee> = new WedgeEmployeeTestTable();
// Local table — not in any reflection source graph, so thread getTable explicitly; other
// lookups (e.g. the delete path's reverse-cascade scan over graph tables) resolve normally.
const getTable = (tableName: string) => (tableName === employeeTable.name ? employeeTable : tableByName(tableName));
const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};
// max: 1 makes pool mechanics observable in miniature. This file must stay its own jest
// file — SpannerDriver.SPANNER_DB is a process-wide static, so the max-1 pool would leak
// into other suites.
const spannerDriver = new SpannerDriver(
  {
    ...spannerConfig,
    sessionPoolOptions: { max: 1, min: 1, acquireTimeout: 2000, fail: true },
  },
  getTable
);

const getSessionPool = (): SessionPool => {
  const db = (spannerDriver as unknown as { getSpannerDb(): Database }).getSpannerDb();
  return (db as unknown as { pool_: SessionPool }).pool_;
};

/**
 * Pool mechanics at max=1 (plans/DB_PERF_PLAN.md P2):
 * 1. The historical wedge — an operation inside a transaction acquiring a SECOND session while
 *    the transaction holds the only one — is DESIGNED OUT by the stateless transaction
 *    contract: every operation inside the body rides the held session, so the shape that
 *    bricked the process cannot be expressed. Proven here at max=1.
 * 2. The exhaustion class that remains REAL — more concurrent transactions than sessions —
 *    is documented with two parallel transactions.
 */
describe('Session pool at max=1 (wedge designed out; real exhaustion documented)', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const preconstructedDb = new Db(spannerDriver, getTable, new TransactionContext());
  const txnDb = new Db(spannerDriver, getTable, new TransactionContext());

  beforeAll(async () => {
    // Fail-closed auth needs an explicit identity (the suite predates the flip — n3xa4 side).
    registerTestUser();
    // HERMETIC single-table world: the delete path's reverse-cascade scan walks getTables();
    // scoping the registry to the local table keeps this suite from querying other suites'
    // graph tables (which don't exist in an isolated run). Object cache wins over the graph.
    (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ] = [employeeTable];
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await spannerDriver.createDbIfNotExists();
    // Setup issues overlapping schema-metadata queries; with fail: true the second acquisition
    // would error instantly at max=1. Let setup queue on the single session, then restore the
    // constructed fail-fast posture for the tests.
    const pool = getSessionPool();
    pool.options.fail = false;
    await spannerDriver.getTableManager().loadTable(employeeTable);
    pool.options.fail = true;
  }, 60000);

  afterAll(async () => {
    getSessionPool().options.fail = false; // teardown queries queue like setup's
    await dropTable(employeeTable);
    await SpannerEmulatorProvisioner.release();
    delete (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ];
    clearTestUser();
  }, 60000);

  test('SpannerConfig.sessionPoolOptions reach the session pool', () => {
    const pool = getSessionPool();
    expect(pool.options.max).toBe(1);
    expect(pool.options.min).toBe(1);
    expect(pool.options.acquireTimeout).toBe(2000);
    expect(pool.options.fail).toBe(true);
  });

  test('wedge DESIGNED OUT: at max=1, a pre-constructed Db inside a transaction rides the held session and just works', async () => {
    const employee: Omit<WedgeEmployee, keyof Record> = {
      name: 'PoolWedgeDesignedOut',
      department: 'Engineering',
    };

    // Under construction-time binding this exact shape was the wedge: the inner query needed a
    // second session the pool didn't have. Statelessness makes it ride the transaction's own
    // session — no acquisition, no exhaustion, correct read.
    const inserted = await txnDb.runTransaction(async () => {
      const emp = await txnDb.insert(employeeTable, employee);
      const seen = await preconstructedDb.query(employeeTable, { name: employee.name });
      expect(seen.length).toBe(1);
      return emp;
    });

    const committed = await preconstructedDb.query(employeeTable, { id: inserted.id });
    expect(committed.length).toBe(1);
    await txnDb.delete(employeeTable, { id: inserted.id });
  }, 30000);

  test('real exhaustion class: a second PARALLEL transaction errors fast when the pool is spent (fail: true)', async () => {
    let releaseHold!: () => void;
    const holdGate = new Promise<void>((resolve) => (releaseHold = resolve));

    // First transaction takes the only session and holds it open on the gate.
    const holder = txnDb.runTransaction(async () => {
      await holdGate;
      return 'held';
    });

    // Second transaction cannot get a session; with fail: true it errors immediately instead
    // of joining the pool's silent infinite FIFO (the production-default hang this file's
    // options exist to surface).
    await expect(preconstructedDb.runTransaction(async () => 'never-runs')).rejects.toMatchObject({
      name: 'SessionPoolExhaustedError',
    });

    releaseHold();
    await expect(holder).resolves.toBe('held');
  }, 30000);
});
