import { Db, QueryBuilderFactory, Record, StringColumn, Table, tableByName, withRecordColumns } from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { SourceRepository } from '@proteinjs/reflection';
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
// Local table — not in any reflection source graph, so thread getTable explicitly; other
// lookups (e.g. the delete path's reverse-cascade scan over graph tables) resolve normally.
const getTable = (tableName: string) => (tableName === employeeTable.name ? employeeTable : tableByName(tableName));
const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};
const spannerDriver = new SpannerDriver(spannerConfig, getTable);

/**
 * The STATELESS transaction contract (plans/DB_PERF_PLAN.md P2, superseding the
 * construction-time-binding guard): Db instances carry no transaction state — every operation
 * resolves the ambient transaction (AsyncLocalStorage) at call time. Inside a transaction body
 * every Db rides the transaction, whenever it was constructed; outside, every Db uses the
 * pool. The one escape shape — work spawned inside a body that outlives the transaction while
 * holding its context — fails loudly by name (the ended-context tombstone).
 */
describe('Transaction safety (stateless contract)', () => {
  const dropTable = getDropTestTable(spannerDriver);
  // Constructed at describe scope, BEFORE any transaction — under the old construction-time
  // binding this instance was the "stale Db" hazard; now it must simply ride whatever ambient
  // transaction is active at call time.
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
    await spannerDriver.getTableManager().loadTable(employeeTable);
  }, 60000);

  afterAll(async () => {
    await dropTable(employeeTable);
    await SpannerEmulatorProvisioner.release();
    delete (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ];
    clearTestUser();
  }, 60000);

  test('a PRE-CONSTRUCTED Db rides the ambient transaction: its reads see the txn write, and the txn commits', async () => {
    const employee: Omit<SafetyEmployee, keyof Record> = {
      name: 'TxnSafetyRides',
      department: 'Engineering',
    };

    const inserted = await txnDb.runTransaction(async () => {
      const emp = await txnDb.insert(employeeTable, employee);
      // The pre-constructed instance resolves the ambient transaction at call time — it sees
      // the uncommitted write (no second session, no stale read: the old hazard shapes).
      const seenInside = await preconstructedDb.query(employeeTable, { id: emp.id });
      expect(seenInside.length).toBe(1);
      return emp;
    });

    const committed = await preconstructedDb.query(employeeTable, { id: inserted.id });
    expect(committed.length).toBe(1);
    await txnDb.delete(employeeTable, { id: inserted.id });
  }, 30000);

  test('a Db constructed INSIDE a transaction, used after commit, cleanly uses the pool and sees committed state', async () => {
    let escapedDb!: Db<SafetyEmployee>;
    const inserted = await txnDb.runTransaction(async () => {
      escapedDb = new Db(spannerDriver, getTable, new TransactionContext());
      return await escapedDb.insert(employeeTable, { name: 'TxnSafetyAfterCommit' } as SafetyEmployee);
    });

    // No instance binding survives the transaction — this is a plain pool-path read now.
    const seen = await escapedDb.query(employeeTable, { id: inserted.id });
    expect(seen.length).toBe(1);
    await escapedDb.delete(employeeTable, { id: inserted.id });
  }, 30000);

  test('atomicity through ANY instance: a rollback takes the pre-constructed Db write with it', async () => {
    await expect(
      txnDb.runTransaction(async () => {
        // If this insert did NOT ride the transaction it would self-commit in its own
        // transaction and survive the rollback below — the exact decay a severed ambient
        // resolution produces (a commit-path assertion can't see it; this one can).
        await preconstructedDb.insert(employeeTable, { name: 'TxnSafetyAtomic' } as SafetyEmployee);
        throw new Error('force-rollback');
      })
    ).rejects.toThrow('force-rollback');

    const after = await preconstructedDb.query(employeeTable, { name: 'TxnSafetyAtomic' });
    expect(after.length).toBe(0);
  }, 30000);

  test('nested transactions throw, from ANY instance', async () => {
    await expect(
      txnDb.runTransaction(async () => {
        await preconstructedDb.runTransaction(async () => 'never-runs');
      })
    ).rejects.toThrow(/already running in this context/);
  }, 30000);

  test('two concurrent transactions on ONE shared instance commit independently', async () => {
    const [a, b] = await Promise.all([
      txnDb.runTransaction(
        async () => await txnDb.insert(employeeTable, { name: 'TxnSafetyConcurrentA' } as SafetyEmployee)
      ),
      txnDb.runTransaction(
        async () => await txnDb.insert(employeeTable, { name: 'TxnSafetyConcurrentB' } as SafetyEmployee)
      ),
    ]);

    const seen = await txnDb.query(
      employeeTable,
      new QueryBuilderFactory()
        .createQueryBuilder(employeeTable)
        .condition({ field: 'id', operator: 'IN', value: [a.id, b.id] })
    );
    expect(seen.length).toBe(2);
    await txnDb.delete(employeeTable, { id: a.id });
    await txnDb.delete(employeeTable, { id: b.id });
  }, 30000);

  test('tombstone: work that escapes a finished transaction fails loudly by name', async () => {
    let releaseEscape!: () => void;
    const escapeGate = new Promise<void>((resolve) => (releaseEscape = resolve));
    let escapedOp!: Promise<unknown>;

    await txnDb.runTransaction(async () => {
      // Spawned inside the body, NOT awaited by it — it captures the transaction's async
      // context and outlives the transaction.
      escapedOp = (async () => {
        await escapeGate;
        return await txnDb.query(employeeTable, { name: 'TxnSafetyEscapee' });
      })();
    });

    releaseEscape();
    await expect(escapedOp).rejects.toThrow(/transaction that already ended/);
  }, 30000);

  test('queries outside any transaction are plain pool reads', async () => {
    const seen = await preconstructedDb.query(employeeTable, { name: 'TxnSafetyNoTxn' });
    expect(seen.length).toBe(0);
  }, 30000);
});
