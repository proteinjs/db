import { Database, SessionPool } from '@google-cloud/spanner';
import { Db, Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
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
// Local table — not in any reflection source graph, so thread getTable explicitly.
const getTable = () => employeeTable;
const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};
// max: 1 makes the historical wedge mechanics reproducible in miniature: `runTransaction`
// holds the single session for the whole transaction, so any unthreaded operation inside it
// must fail to acquire. This file must stay its own jest file — SpannerDriver.SPANNER_DB is a
// process-wide static, so the max-1 pool would leak into other suites.
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
 * P2 wedge miniature (plans/DB_PERF_PLAN.md): under load, N concurrent transactions hold all
 * N sessions while each blocks acquiring one more for an unthreaded inner query — with the
 * default infinite acquireTimeout this never errors (the historical "bricked process").
 * At max=1 a single transaction + one unthreaded query reproduce the mechanics.
 */
describe('Session pool exhaustion (transaction wedge miniature)', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const staleDb = new Db(spannerDriver, getTable, new TransactionContext());
  const txnDb = new Db(spannerDriver, getTable, new TransactionContext());
  const priorDevelopment = process.env.DEVELOPMENT;

  beforeAll(async () => {
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
  }, 60000);

  afterEach(() => {
    if (priorDevelopment === undefined) {
      delete process.env.DEVELOPMENT;
    } else {
      process.env.DEVELOPMENT = priorDevelopment;
    }
  });

  test('SpannerConfig.sessionPoolOptions reach the session pool', () => {
    const pool = getSessionPool();
    expect(pool.options.max).toBe(1);
    expect(pool.options.min).toBe(1);
    expect(pool.options.acquireTimeout).toBe(2000);
    expect(pool.options.fail).toBe(true);
  });

  test('wedge: unthreaded query inside a transaction fails to acquire a second session (fail: true)', async () => {
    delete process.env.DEVELOPMENT;
    const employee: Omit<WedgeEmployee, keyof Record> = {
      name: 'PoolWedgeFailFast',
      department: 'Engineering',
    };

    await expect(
      txnDb.runTransaction(async () => {
        // Rides the held session — no second acquisition, works fine.
        await txnDb.insert(employeeTable, employee);
        // Unthreaded — needs a second session; the pool has none.
        await staleDb.query(employeeTable, { name: employee.name });
      })
    ).rejects.toMatchObject({ name: 'SessionPoolExhaustedError' });

    // The failed transaction rolled back and released its session.
    const seen = await staleDb.query(employeeTable, { name: employee.name });
    expect(seen.length).toBe(0);
  }, 30000);

  test('wedge: with fail: false the unthreaded query hangs until acquireTimeout', async () => {
    delete process.env.DEVELOPMENT;
    const pool = getSessionPool();
    // fail: false is the pool's default — this is the exact historical hang, bounded here by
    // the finite acquireTimeout so the test can observe it.
    pool.options.fail = false;

    try {
      const start = Date.now();
      await expect(
        txnDb.runTransaction(async () => {
          await staleDb.query(employeeTable, { name: 'PoolWedgeHang' });
        })
      ).rejects.toThrow('Timeout occurred while acquiring session');
      expect(Date.now() - start).toBeGreaterThanOrEqual(1900);
    } finally {
      pool.options.fail = true;
    }
  }, 30000);

  test('guard: in DEVELOPMENT the unthreaded query fails immediately, before touching the pool', async () => {
    process.env.DEVELOPMENT = 'true';

    const start = Date.now();
    await expect(
      txnDb.runTransaction(async () => {
        await staleDb.query(employeeTable, { name: 'PoolWedgeGuard' });
      })
    ).rejects.toThrow(/without riding it/);
    expect(Date.now() - start).toBeLessThan(1500);
  }, 30000);
});
