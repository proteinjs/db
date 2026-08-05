import { Db, Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

interface SafetyEmployee extends Record {
  name: string;
  department?: string;
}

class SafetyEmployeeTestTable extends Table<SafetyEmployee> {
  name = 'db_test_txn_safety_employee';
  columns = withRecordColumns<SafetyEmployee>({
    name: new StringColumn('name'),
    department: new StringColumn('department'),
  });
}

const employeeTable: Table<SafetyEmployee> = new SafetyEmployeeTestTable();
// Local table — not in any reflection source graph, so thread getTable explicitly.
const getTable = () => employeeTable;
const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};
const spannerDriver = new SpannerDriver(spannerConfig, getTable);

/**
 * P2 transaction-safety tests (plans/DB_PERF_PLAN.md).
 *
 * `Db` picks up the ambient transaction (AsyncLocalStorage) at CONSTRUCTION time. A Db
 * instance constructed before `runTransaction` began therefore issues its queries outside
 * the transaction: non-atomic reads that cannot see the transaction's own writes, and a
 * second session acquisition from the pool (the historical wedge — see
 * SessionPoolExhaustion.test.ts for the miniature).
 */
describe('Transaction safety', () => {
  const dropTable = getDropTestTable(spannerDriver);
  // Constructed at module/describe scope, BEFORE any transaction begins — the hole under test.
  const staleDb = new Db(spannerDriver, getTable, new TransactionContext());
  const txnDb = new Db(spannerDriver, getTable, new TransactionContext());
  const priorDevelopment = process.env.DEVELOPMENT;

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await spannerDriver.createDbIfNotExists();
    await spannerDriver.getTableManager().loadTable(employeeTable);
  }, 60000);

  afterAll(async () => {
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

  /**
   * Test 1 (documentation of the correctness hole; log-mode, so behavior is unchanged by the
   * guard): a query through a pre-transaction Db instance cannot see the transaction's own
   * uncommitted write.
   */
  test('unthreaded query inside a transaction reads stale state (cannot see the txn write)', async () => {
    delete process.env.DEVELOPMENT;
    const employee: Omit<SafetyEmployee, keyof Record> = {
      name: 'TxnSafetyStaleRead',
      department: 'Engineering',
    };
    let insertedId: string | undefined;
    let threadedReadCount: number | undefined;
    let unthreadedReadCount: number | undefined;

    await expect(
      txnDb.runTransaction(async () => {
        const emp = await txnDb.insert(employeeTable, employee);
        insertedId = emp.id;

        // Rides the transaction — sees its own uncommitted write.
        threadedReadCount = (await txnDb.query(employeeTable, { id: emp.id })).length;

        // Does NOT ride the transaction — the uncommitted write is invisible. This is the
        // correctness hole the guard exists to surface.
        unthreadedReadCount = (await staleDb.query(employeeTable, { id: emp.id })).length;

        // End the transaction here on purpose: the emulator aborts an active read-write
        // transaction when a second session reads concurrently, so letting it run to commit
        // would put the client library into its abort-retry loop. A non-abort error
        // propagates immediately and keeps the demonstration deterministic.
        throw new Error('end-of-demonstration');
      })
    ).rejects.toThrow('end-of-demonstration');

    expect(threadedReadCount).toBe(1);
    expect(unthreadedReadCount).toBe(0);

    // The transaction rolled back — the unthreaded read's blindness above was purely
    // transaction-visibility (it read the same, still-empty committed state as now).
    const afterRollback = await staleDb.query(employeeTable, { id: insertedId });
    expect(afterRollback.length).toBe(0);
  }, 30000);

  /**
   * Test 3 (the guard's contract): with DEVELOPMENT set, a query reaching the driver while an
   * ambient transaction is active WITHOUT riding it throws immediately, naming the offense.
   */
  test('guard: unthreaded query inside a transaction throws in DEVELOPMENT', async () => {
    process.env.DEVELOPMENT = 'true';

    await expect(
      txnDb.runTransaction(async () => {
        await staleDb.query(employeeTable, { name: 'TxnSafetyGuardProbe' });
      })
    ).rejects.toThrow(/without riding it/);
  }, 30000);

  /**
   * Review finding (Wave-1 adversarial pass): a STALE instance calling runTransaction inside
   * an ambient transaction escaped both the instance-state nesting check and the driver-call
   * guard — silently opening a PARALLEL transaction (second session held inside the first,
   * the pool-wedge class itself). The ambient-aware nesting check closes it UNCONDITIONALLY
   * (documented contract: nested transactions throw), not just in DEVELOPMENT.
   */
  test('nested transaction via a stale instance throws (parallel-transaction wedge closed)', async () => {
    delete process.env.DEVELOPMENT;

    await expect(
      txnDb.runTransaction(async () => {
        await expect(staleDb.runTransaction(async () => 'never-runs')).rejects.toThrow(/constructed before it began/);
        // Deterministic transaction end (see the stale-read test's emulator abort note).
        throw new Error('end-of-demonstration');
      })
    ).rejects.toThrow('end-of-demonstration');
  }, 30000);

  /**
   * Review finding (Wave-1 adversarial pass): the guard only fired when an AMBIENT transaction
   * was active — an instance still holding a transaction its context no longer carries
   * (constructed inside a transaction, used after it ended) handed the ENDED transaction to
   * the driver unguarded. The symmetric check surfaces it.
   */
  test('guard: instance created inside a transaction, used after it ended, throws in DEVELOPMENT', async () => {
    process.env.DEVELOPMENT = 'true';

    let escapedDb: Db | undefined;
    await txnDb.runTransaction(async () => {
      escapedDb = new Db(spannerDriver, getTable, new TransactionContext());
    });

    await expect(escapedDb!.query(employeeTable, { name: 'TxnSafetyEnded' })).rejects.toThrow(/no longer carries/);
  }, 30000);

  test('guard: threaded operations inside a transaction are untouched in DEVELOPMENT', async () => {
    process.env.DEVELOPMENT = 'true';
    const employee: Omit<SafetyEmployee, keyof Record> = {
      name: 'TxnSafetyThreaded',
      department: 'Engineering',
    };

    const inserted = await txnDb.runTransaction(async () => {
      const emp = await txnDb.insert(employeeTable, employee);
      const seen = await txnDb.query(employeeTable, { id: emp.id });
      expect(seen.length).toBe(1);

      // A Db constructed INSIDE the transaction picks up the ambient transaction at
      // construction — the common path the guard must never fire on.
      const innerDb = new Db(spannerDriver, getTable, new TransactionContext());
      const innerSeen = await innerDb.query(employeeTable, { id: emp.id });
      expect(innerSeen.length).toBe(1);

      return emp;
    });

    expect(inserted.id).toBeDefined();
  }, 30000);

  test('guard: queries outside any transaction are untouched in DEVELOPMENT', async () => {
    process.env.DEVELOPMENT = 'true';
    const seen = await staleDb.query(employeeTable, { name: 'TxnSafetyNoTxn' });
    expect(seen.length).toBe(0);
  }, 30000);
});
