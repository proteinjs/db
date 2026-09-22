import { Db, Record, StringColumn, Table, tableByName, withRecordColumns } from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { Database, Transaction } from '@google-cloud/spanner';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { SourceRepository } from '@proteinjs/reflection';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * A read-write transaction is a SEQUENCE on the wire. The client numbers every request it sends
 * on a transaction (`seqno`) at the moment the call is made, and Spanner refuses a DML whose
 * number arrives after a higher one: `INVALID_ARGUMENT: Request has an out-of-order seqno` —
 * the caller's statement fails and the transaction with it. A body that composes its writes
 * concurrently (`Promise.all` of updates inside one transaction — a natural shape for a
 * fan-out) therefore loses whole transactions whenever the network reorders two sends.
 *
 * Contract under test: the DRIVER owns the order. Every statement issued on a transaction
 * handle is handed to the wire once the statement before it has been answered, so concurrent
 * callers inside one transaction are ordered, never rejected — and a statement that failed
 * still yields its turn.
 *
 * The reorder is driven deterministically at the transport seam (the resolved gRPC stub the
 * gapic layer invokes): the FIRST matching ExecuteBatchDml send is held until the SECOND has
 * been answered. Pre-fix both sends are issued at once and the held one reaches the emulator
 * with the lower number after the higher — the exact production failure. Post-fix the second
 * is not issued until the first is answered, so the hold merely delays it; both land, in order.
 */

interface OrderedRow extends Record {
  name: string;
}

class OrderedRowTestTable extends Table<OrderedRow> {
  name = 'db_test_statements_in_order';
  columns = withRecordColumns<OrderedRow>({
    name: new StringColumn('name'),
  });
}

const table: Table<OrderedRow> = new OrderedRowTestTable();
const getTable = (tableName: string) => (tableName === table.name ? table : tableByName(tableName));
const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};
const spannerDriver = new SpannerDriver(spannerConfig, getTable);

const updateSqlMarker = 'UPDATE `db_test_statements_in_order`';
const isUpdateSql = (sql: string) => sql.includes(updateSqlMarker);

/** The resolved gRPC stub the gapic layer invokes — the transport seam. */
const getSpannerStub = async (): Promise<any> => {
  const spanner = (SpannerDriver as unknown as { SPANNER?: any }).SPANNER;
  if (!spanner) {
    throw new Error('SpannerDriver.SPANNER not initialized — run an op first');
  }
  const gapicClient = spanner.clients_.get('SpannerClient');
  if (!gapicClient) {
    throw new Error('SpannerClient gapic client not created — run a data op first');
  }
  return await gapicClient.spannerStub;
};

type ReorderPatch = {
  /** The seqnos of the matching sends in the order they reached the wire. */
  wireOrder: () => number[];
  restore: () => void;
};

/**
 * Hold the FIRST matching ExecuteBatchDml send until the SECOND matching one has been answered
 * (or, when no second send is issued within `holdMs`, release it) — the network reordering two
 * concurrent sends, made deterministic.
 */
const patchReorder = (stub: any, isTargetSql: (sql: string) => boolean, holdMs: number): ReorderPatch => {
  const original = stub.executeBatchDml;
  const wireOrder: number[] = [];
  let seen = 0;
  let releaseFirst: (() => void) | undefined;
  stub.executeBatchDml = function (this: any, ...args: any[]) {
    const request = args[0];
    const statements: any[] = request?.statements ?? [];
    if (!statements.some((statement) => typeof statement?.sql === 'string' && isTargetSql(statement.sql))) {
      return original.apply(this, args);
    }
    seen += 1;
    const send = () => {
      wireOrder.push(Number(request.seqno));
      return original.apply(this, args);
    };
    if (seen === 1) {
      let handle: any;
      const timer = setTimeout(() => releaseFirst?.(), holdMs);
      releaseFirst = () => {
        releaseFirst = undefined;
        clearTimeout(timer);
        handle = send();
      };
      return { cancel: () => handle?.cancel?.() };
    }
    const callback = args[args.length - 1];
    const answered = (...results: unknown[]) => {
      callback(...results);
      // The second send is answered: let the held first one go — after it, on the wire.
      setImmediate(() => releaseFirst?.());
    };
    wireOrder.push(Number(request.seqno));
    return original.apply(this, [...args.slice(0, -1), answered]);
  };
  return { wireOrder: () => wireOrder, restore: () => (stub.executeBatchDml = original) };
};

describe('statements issued concurrently in one transaction reach the wire in order', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const db = new Db(spannerDriver, getTable, new TransactionContext());

  beforeAll(async () => {
    registerTestUser();
    (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ] = [table];
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await spannerDriver.createDbIfNotExists();
    await spannerDriver.getTableManager().loadTable(table);
    // Warm the data client so the gapic SpannerClient + resolved stub exist to patch.
    await db.query(table, { name: 'warmup' });
  }, 60000);

  afterAll(async () => {
    await dropTable(table);
    await SpannerEmulatorProvisioner.release();
    delete (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ];
    clearTestUser();
  }, 60000);

  afterEach(async () => {
    const leftovers = await db.query(table, {});
    for (const row of leftovers) {
      await db.delete(table, { id: row.id } as any);
    }
  }, 30000);

  test('two updates fired with Promise.all inside one transaction: both land, in issue order, with the network reordering their sends', async () => {
    const a = await db.insert(table, { name: 'a' });
    const b = await db.insert(table, { name: 'b' });
    const stub = await getSpannerStub();
    const patch = patchReorder(stub, isUpdateSql, 2000);
    let outcome: unknown;
    try {
      outcome = await db
        .runTransaction(async () => {
          // The fan-out shape: two statements issued at once inside the body.
          await Promise.all([
            db.update(table, { name: 'a-updated' }, { id: a.id }),
            db.update(table, { name: 'b-updated' }, { id: b.id }),
          ]);
        })
        .then(() => 'resolved' as const)
        .catch((error: Error) => error);
    } finally {
      patch.restore();
    }

    // The transaction committed — never `INVALID_ARGUMENT: Request has an out-of-order seqno`.
    expect(outcome).toBe('resolved');
    // Both statements reached the wire, in issue order (the driver handed the second to the
    // wire only once the first was answered, so the hold could not reorder them).
    const order = patch.wireOrder();
    expect(order).toHaveLength(2);
    expect(order[0]).toBeLessThan(order[1]);
    // Both writes are stored.
    expect((await db.get(table, { id: a.id })).name).toBe('a-updated');
    expect((await db.get(table, { id: b.id })).name).toBe('b-updated');
  }, 30000);

  test('the lane itself: a failed statement yields its turn; sends on one handle never overlap; a Database handle sends at once', async () => {
    type Lane = { inStatementOrder<T>(runner: unknown, send: () => Promise<T>): Promise<T> };
    const lane = spannerDriver as unknown as Lane;
    const handle = Object.create(Transaction.prototype); // a transaction handle, no wire behind it
    const trace: string[] = [];
    let releaseFirst!: () => void;
    const first = lane.inStatementOrder(handle, () => {
      trace.push('first sent');
      return new Promise<never>((_, reject) => (releaseFirst = () => reject(new Error('first failed'))));
    });
    const second = lane.inStatementOrder(handle, async () => {
      trace.push('second sent');
      return 'second answered';
    });
    await new Promise((r) => setImmediate(r));
    expect(trace).toEqual(['first sent']); // the second waits for the first's answer
    releaseFirst();
    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe('second answered');
    expect(trace).toEqual(['first sent', 'second sent']);

    // Another handle is another sequence: its statement does not queue behind this one's.
    const other = Object.create(Transaction.prototype);
    let releaseThird!: () => void;
    void lane.inStatementOrder(handle, () => new Promise<void>((r) => (releaseThird = r)));
    await expect(lane.inStatementOrder(other, async () => 'other handle')).resolves.toBe('other handle');
    releaseThird();

    // A Database handle (a single-use read) has no sequence: the send is immediate.
    const database = Object.create(Database.prototype);
    let sent = false;
    const immediate = lane.inStatementOrder(database, async () => {
      sent = true;
      return 'now';
    });
    expect(sent).toBe(true);
    await expect(immediate).resolves.toBe('now');
  });
});
