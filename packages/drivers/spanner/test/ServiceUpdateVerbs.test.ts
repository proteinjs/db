import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import {
  ArrayMembershipUpdate,
  computeArrayMembershipOps,
  Db,
  isTable,
  PreservedPath,
  ReferenceArray,
  Table,
  tableByName,
} from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import {
  ServiceVerbsDoc,
  ServiceVerbsDocTable,
  serviceVerbsScopeContext as scope,
} from './util/serviceUpdateVerbsTestTables';
import '../generated/test/index';

/**
 * The RMW update verbs (`updateArrayMembership`, `updatePreserving`) over the DbService RPC
 * path, against real Spanner transaction semantics.
 *
 * The service path differs from bespoke server code in three load-bearing ways, each pinned here:
 * - ONE long-lived `Db` instance serves every request (ServiceRouter builds its executor map
 *   once), so the verbs' self-wrapped transactions must not couple concurrent callers through
 *   instance state.
 * - args cross a serialization boundary: `Table` as `{ tableName }` resolved via `tableByName`,
 *   the op payloads (`ArrayMembershipUpdate`, `PreservedPath`) as plain JSON.
 * - authorization is the `TableServiceAuth.canAccess(methodName, args)` gate plus scoped/column
 *   query injection inside the verb's read-modify-write — an out-of-scope row must behave as
 *   nonexistent.
 */

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

describe('DbService RMW update verbs (updateArrayMembership / updatePreserving)', () => {
  const docTable = new ServiceVerbsDocTable() as Table<ServiceVerbsDoc>;
  const dropTable = getDropTestTable(spannerDriver);
  // Service-singleton shaped: one shared instance, default table resolution (tableByName).
  const db = new Db<ServiceVerbsDoc>(spannerDriver, undefined, new TransactionContext());

  /**
   * The wire forms the Serializer produces for DbService args: `Table` crosses as its name and is
   * resolved via `tableByName` server-side (TableSerializer); the op payloads are plain JSON.
   */
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

  const memberIds = async (id: string) => {
    const row = await db.get(docTable, { id });
    return row?.members?._ids;
  };

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    await dropTable(docTable);
    await spannerDriver.getTableManager().loadTable(docTable);
  }, 60000);

  afterAll(async () => {
    await dropTable(docTable);
    await SpannerEmulatorProvisioner.release();
  }, 30000);

  beforeEach(() => {
    scope.current = 'scope-a';
  });

  test('membership ops apply against committed truth, not the caller list snapshot', async () => {
    const doc = await db.insert(docTable, {
      title: 'd1',
      members: new ReferenceArray(docTable.name, ['a', 'b', 'c']),
    });
    // Another writer's committed wholesale update adds `d` — the caller's snapshot is now stale.
    await db.update(docTable, { id: doc.id, members: new ReferenceArray(docTable.name, ['a', 'b', 'c', 'd']) });

    // The caller computed remove(b) against the stale base [a, b, c].
    const update: ArrayMembershipUpdate = {
      recordId: doc.id,
      columnPropertyName: 'members',
      ops: computeArrayMembershipOps(['a', 'b', 'c'], ['a', 'c']),
    };
    expect(await rpc('updateArrayMembership', [docTable, update])).toBe(1);

    // Both writers' effects survive; a wholesale write of the stale list would have erased `d`.
    expect(await memberIds(doc.id)).toEqual(['a', 'c', 'd']);
  });

  test('a scoped caller cannot touch another scope’s row via updateArrayMembership', async () => {
    const doc = await db.insert(docTable, { title: 'd2', members: new ReferenceArray(docTable.name, ['a', 'b']) });

    scope.current = 'scope-b';
    const removeA: ArrayMembershipUpdate = {
      recordId: doc.id,
      columnPropertyName: 'members',
      ops: [{ op: 'remove', id: 'a' }],
    };
    expect(await rpc('updateArrayMembership', [docTable, removeA])).toBe(0);

    scope.current = 'scope-a';
    expect(await memberIds(doc.id)).toEqual(['a', 'b']);

    // The owning scope can perform the identical op.
    expect(await rpc('updateArrayMembership', [docTable, removeA])).toBe(1);
    expect(await memberIds(doc.id)).toEqual(['b']);
  });

  test('a scoped caller cannot touch another scope’s row via updatePreserving', async () => {
    const doc = await db.insert(docTable, { title: 'd3', body: { content: 'v1', style: { color: 'blue' } } });

    scope.current = 'scope-b';
    const preserve: PreservedPath[] = [{ columnPropertyName: 'body', paths: ['content'], whenType: 'string' }];
    const foreignWrite = { id: doc.id, body: { content: 'hijack', style: { color: 'red' } } };
    expect(await rpc('updatePreserving', [docTable, foreignWrite, preserve])).toBe(0);

    scope.current = 'scope-a';
    const row = await db.get(docTable, { id: doc.id });
    expect(row.body).toEqual({ content: 'v1', style: { color: 'blue' } });
  });

  test('updatePreserving over the service preserves the committed sub-path while writing owned paths', async () => {
    const doc = await db.insert(docTable, { title: 'd4', body: { content: 'v1', style: { color: 'blue' } } });
    // The owning writer's committed text save; the structural writer's payload still carries v1.
    await db.update(docTable, { id: doc.id, body: { content: 'v2', style: { color: 'blue' } } });

    const preserve: PreservedPath[] = [{ columnPropertyName: 'body', paths: ['content'], whenType: 'string' }];
    const stalePayload = { id: doc.id, body: { content: 'v1', style: { color: 'red' } } };
    expect(await rpc('updatePreserving', [docTable, stalePayload, preserve])).toBe(1);

    const row = await db.get(docTable, { id: doc.id });
    expect(row.body).toEqual({ content: 'v2', style: { color: 'red' } });
  });

  test('concurrent RPCs on the shared service instance get isolated transactions', async () => {
    const doc = await db.insert(docTable, { title: 'd5', members: new ReferenceArray(docTable.name, ['seed']) });

    // The service singleton serves concurrent requests; each self-wrapped RMW transaction must be
    // isolated (no cross-request transaction bleed through shared instance state), and every
    // membership add must land. Issuance is STAGGERED so later requests arrive while an earlier
    // request's transaction is open — the shape that makes shared instance state bleed: a
    // simultaneous burst would let every call check the (still unset) transaction state before
    // any transaction opens, masking the coupling.
    const addedIds = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    const inFlight: Promise<unknown>[] = [];
    for (const id of addedIds) {
      inFlight.push(
        rpc('updateArrayMembership', [
          docTable,
          { recordId: doc.id, columnPropertyName: 'members', ops: [{ op: 'add', id, afterId: 'seed' }] },
        ])
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.all(inFlight);

    expect([...((await memberIds(doc.id)) ?? [])].sort()).toEqual([...addedIds, 'seed'].sort());
  }, 60000);

  test('updateArrayMembership rejects a non-ReferenceArrayColumn target', async () => {
    const doc = await db.insert(docTable, { title: 'd6' });
    await expect(
      rpc('updateArrayMembership', [
        docTable,
        { recordId: doc.id, columnPropertyName: 'title', ops: [{ op: 'add', id: 'x', afterId: null }] },
      ])
    ).rejects.toThrow('requires a ReferenceArrayColumn');
  });
});
