import { PassThrough } from 'stream';
import { Db, Record, StringColumn, Table, tableByName, withRecordColumns } from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { SourceRepository } from '@proteinjs/reflection';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * DML retry safety (the 2026-08-13 splice incident class): a DML request whose response is LOST
 * in transport must NEVER be transparently re-sent by the client. On the pre-fix streaming DML
 * path (`runUpdate` → ExecuteStreamingSql), gax wraps every attempt in retry-request, which
 * silently replays on ANY pre-response error. Seqno replay protection only covers the
 * same-transaction geometry; the replay geometries it cannot cover are where the incident lived:
 * an inline-begin replay BEGINS A FRESH TRANSACTION per attempt (abandoned applied-but-
 * uncommitted siblings churn locks and collide with rows committed by other paths — the
 * spurious `6 ALREADY_EXISTS` under pool pressure), and the stream-resumption layer re-mints a
 * NEW seqno into the SAME transaction after inline-begin learned its id (unprotected even on
 * real Spanner).
 *
 * These tests drive the retry deterministically by injecting loss at the TRANSPORT SEAM — the
 * resolved gRPC stub method, which the gapic layer looks up per attempt
 * (`stub[methodName].apply`), i.e. the exact function every transparent retry re-invokes.
 *
 * Contract under test (the fix): DML rides the unary ExecuteBatchDml RPC, and under the emulator
 * the call is single-attempt (`retry: null`) — a loss surfaces as the loss itself, after at most
 * ONE wire execution.
 */

interface RetryAnchor extends Record {
  name: string;
}

interface RetryTarget extends Record {
  name: string;
}

class RetryAnchorTestTable extends Table<RetryAnchor> {
  name = 'db_test_dml_retry_anchor';
  columns = withRecordColumns<RetryAnchor>({
    name: new StringColumn('name'),
  });
}

class RetryTargetTestTable extends Table<RetryTarget> {
  name = 'db_test_dml_retry_target';
  columns = withRecordColumns<RetryTarget>({
    name: new StringColumn('name'),
  });
}

const anchorTable: Table<RetryAnchor> = new RetryAnchorTestTable();
const targetTable: Table<RetryTarget> = new RetryTargetTestTable();
// Local tables — not in any reflection source graph, so thread getTable explicitly (the
// TransactionSafety pattern); other lookups resolve normally.
const getTable = (tableName: string) => {
  if (tableName === anchorTable.name) {
    return anchorTable;
  }
  if (tableName === targetTable.name) {
    return targetTable;
  }
  return tableByName(tableName);
};
const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};
const spannerDriver = new SpannerDriver(spannerConfig, getTable);

const INJECTED_LOSS = 'injected response loss';
const targetInsertSqlMarker = `INSERT INTO \`db_test_dml_retry_target\``;
const isTargetInsertSql = (sql: string) => sql.includes(targetInsertSqlMarker);

type StubPatch = { attempts: () => number; restore: () => void };
/**
 * 'applied-then-lost': the first attempt reaches the emulator (the statement EXECUTES
 * server-side) but its response is dropped — the incident's loss shape. 'lost-in-flight': the
 * first attempt never reaches the emulator — a transparent replay makes the op silently
 * SUCCEED behind a "failed" attempt (the smoking gun that a replay layer exists).
 */
type LossMode = 'applied-then-lost' | 'lost-in-flight';

/** The resolved gRPC stub the gapic layer re-invokes per attempt — the transport seam. */
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

const makeLossError = (): Error => {
  const error: any = new Error(INJECTED_LOSS);
  error.code = 14; // UNAVAILABLE — the shape of a dropped connection / lost response
  return error;
};

/** Inject loss on the FIRST matching ExecuteStreamingSql attempt; later attempts pass through. */
const patchStreamingLoss = (stub: any, isTargetSql: (sql: string) => boolean, mode: LossMode): StubPatch => {
  const original = stub.executeStreamingSql;
  let attempts = 0;
  stub.executeStreamingSql = function (this: any, ...args: any[]) {
    const request = args[0];
    if (typeof request?.sql !== 'string' || !isTargetSql(request.sql)) {
      return original.apply(this, args);
    }
    attempts += 1;
    if (attempts > 1) {
      return original.apply(this, args);
    }
    const wrapper: any = new PassThrough({ objectMode: true });
    let injected = false;
    const inject = () => {
      if (injected) {
        return;
      }
      injected = true;
      wrapper.emit('error', makeLossError());
    };
    if (mode === 'lost-in-flight') {
      wrapper.cancel = () => undefined;
      setImmediate(inject);
      return wrapper;
    }
    const real = original.apply(this, args);
    wrapper.cancel = () => real.cancel?.();
    real.on('data', () => undefined); // drain — the response is consumed and dropped
    real.on('metadata', () => undefined);
    real.on('error', inject);
    real.on('status', inject);
    real.on('end', inject);
    return wrapper;
  };
  return { attempts: () => attempts, restore: () => (stub.executeStreamingSql = original) };
};

/** Inject loss on the FIRST matching ExecuteBatchDml attempt; later attempts pass through. */
const patchUnaryLoss = (stub: any, isTargetSql: (sql: string) => boolean, mode: LossMode): StubPatch => {
  const original = stub.executeBatchDml;
  let attempts = 0;
  stub.executeBatchDml = function (this: any, ...args: any[]) {
    const request = args[0];
    const statements: any[] = request?.statements ?? [];
    if (!statements.some((statement) => typeof statement?.sql === 'string' && isTargetSql(statement.sql))) {
      return original.apply(this, args);
    }
    attempts += 1;
    if (attempts > 1) {
      return original.apply(this, args);
    }
    const callback = args[args.length - 1];
    if (typeof callback !== 'function') {
      throw new Error('expected trailing callback on unary stub call');
    }
    if (mode === 'lost-in-flight') {
      setImmediate(() => callback(makeLossError()));
      return { cancel: () => undefined };
    }
    const lossyCallback = () => callback(makeLossError());
    return original.apply(this, [...args.slice(0, -1), lossyCallback]);
  };
  return { attempts: () => attempts, restore: () => (stub.executeBatchDml = original) };
};

/** Pass-through counter for DML on the streaming transport — must stay ZERO post-fix. */
const patchStreamingDmlCounter = (stub: any, isTargetSql: (sql: string) => boolean): StubPatch => {
  const original = stub.executeStreamingSql;
  let attempts = 0;
  stub.executeStreamingSql = function (this: any, ...args: any[]) {
    if (typeof args[0]?.sql === 'string' && isTargetSql(args[0].sql)) {
      attempts += 1;
    }
    return original.apply(this, args);
  };
  return { attempts: () => attempts, restore: () => (stub.executeStreamingSql = original) };
};

describe('DML retry safety (a lost response must never re-execute a statement)', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const db = new Db(spannerDriver, getTable, new TransactionContext());

  beforeAll(async () => {
    registerTestUser();
    // HERMETIC two-table world (the TransactionSafety pattern): the delete path's
    // reverse-cascade scan walks getTables(); scope the registry to the local tables.
    (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ] = [anchorTable, targetTable];
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await spannerDriver.createDbIfNotExists();
    await spannerDriver.getTableManager().loadTable(anchorTable);
    await spannerDriver.getTableManager().loadTable(targetTable);
    // Warm the data client so the gapic SpannerClient + resolved stub exist to patch.
    await db.query(targetTable, { name: 'warmup' });
  }, 60000);

  afterAll(async () => {
    await dropTable(targetTable);
    await dropTable(anchorTable);
    await SpannerEmulatorProvisioner.release();
    delete (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ];
    clearTestUser();
  }, 60000);

  afterEach(async () => {
    // Tests assert their own outcomes; this just keeps rows from leaking across tests.
    for (const table of [targetTable, anchorTable]) {
      const leftovers = await db.query(table as Table<any>, {});
      for (const row of leftovers) {
        await db.delete(table as Table<any>, { id: row.id } as any);
      }
    }
  }, 30000);

  test('in-transaction DML, response lost after the emulator applied it: the loss surfaces (no self-collision), one wire execution, nothing commits', async () => {
    const stub = await getSpannerStub();
    const streamingPatch = patchStreamingLoss(stub, isTargetInsertSql, 'applied-then-lost');
    const unaryPatch = patchUnaryLoss(stub, isTargetInsertSql, 'applied-then-lost');
    let outcome: unknown;
    try {
      outcome = await db
        .runTransaction(async () => {
          // Statement 1 establishes the transaction id; statement 2 is the target DML whose
          // response is lost AFTER the emulator applied it. Pre-fix, retry-request transparently
          // replayed it (2 wire attempts; the op only survived because same-txn same-seqno
          // replays happen to be absorbed by backend replay protection — the inline-begin
          // geometry has no such shield). The contract: ONE wire execution, the LOSS surfaces.
          await db.insert(anchorTable, { name: 'RetryAnchorA' });
          await db.insert(targetTable, { name: 'RetryTargetA' });
        })
        .then(() => 'resolved' as const)
        .catch((error: Error) => error);
    } finally {
      streamingPatch.restore();
      unaryPatch.restore();
    }

    // The surfaced failure is the injected loss — NOT a replay self-collision (6 ALREADY_EXISTS).
    expect(outcome).toBeInstanceOf(Error);
    expect(String((outcome as Error).message)).toContain(INJECTED_LOSS);
    expect((outcome as any).code).not.toBe(6);
    // Exactly one wire execution of the target DML across both transports.
    expect(streamingPatch.attempts() + unaryPatch.attempts()).toBe(1);
    // The failed transaction committed nothing.
    expect(await db.query(targetTable, { name: 'RetryTargetA' })).toHaveLength(0);
    expect(await db.query(anchorTable, { name: 'RetryAnchorA' })).toHaveLength(0);
  }, 30000);

  test('standalone DML (inline begin), request lost in flight: the loss surfaces, one wire attempt, no row materializes behind the failure', async () => {
    const stub = await getSpannerStub();
    const streamingPatch = patchStreamingLoss(stub, isTargetInsertSql, 'lost-in-flight');
    const unaryPatch = patchUnaryLoss(stub, isTargetInsertSql, 'lost-in-flight');
    let outcome: unknown;
    try {
      outcome = await db
        .insert(targetTable, { name: 'RetryTargetB' })
        .then(() => 'resolved' as const)
        .catch((error: Error) => error);
    } finally {
      streamingPatch.restore();
      unaryPatch.restore();
    }

    // The op fails with the injected loss — it is NOT silently healed by a transparent replay
    // (a replay resolves the op and materializes a row behind a "failed" attempt).
    expect(outcome).toBeInstanceOf(Error);
    expect(String((outcome as Error).message)).toContain(INJECTED_LOSS);
    expect(streamingPatch.attempts() + unaryPatch.attempts()).toBe(1);
    expect(await db.query(targetTable, { name: 'RetryTargetB' })).toHaveLength(0);
  }, 30000);

  test('happy path: DML rides the unary RPC (streaming carries none), commits exactly once with faithful row counts', async () => {
    const stub = await getSpannerStub();
    const isTargetDmlSql = (sql: string) =>
      sql.includes('`db_test_dml_retry_target`') && !sql.trim().startsWith('SELECT');
    const streamingCounter = patchStreamingDmlCounter(stub, isTargetDmlSql);
    try {
      const inserted = await db.runTransaction(async () => {
        await db.insert(anchorTable, { name: 'RetryAnchorC' });
        return await db.insert(targetTable, { name: 'RetryTargetC' });
      });

      const committed = await db.query(targetTable, { name: 'RetryTargetC' });
      expect(committed).toHaveLength(1);
      // Row counts flow faithfully through the unary path.
      expect(await db.update(targetTable, { name: 'RetryTargetC-updated' }, { id: inserted.id })).toBe(1);
      expect(await db.delete(targetTable, { id: inserted.id })).toBe(1);
      // No DML (insert/update/delete) ever touched the streaming transport, whose retry
      // layers transparently replay lost responses.
      expect(streamingCounter.attempts()).toBe(0);
    } finally {
      streamingCounter.restore();
    }
  }, 30000);
});
