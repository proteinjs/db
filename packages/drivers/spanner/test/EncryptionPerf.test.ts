import {
  Db,
  Table,
  setDbEncryptionConfig,
  InMemoryMasterKeyProvider,
  DataKeyStore,
  EncryptionEnvelope,
  QueryBuilder,
} from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import { EncPerfRow, EncPerfRowTable, PlainPerfRowTable } from './util/columnEncryptionTestTables';
import { loadColumnEncryptionTestSchema, purgeColumnEncryptionTestRows } from './util/columnEncryptionTestHarness';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import '../generated/test/index';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

(globalThis as any)['__proteinjs_db_defaultDbDriver'] = spannerDriver;

const OWNER = 'enc-perf-owner-a';
const ROW_COUNT = 1000;

const encTable = new EncPerfRowTable() as Table<EncPerfRow>;
const plainTable = new PlainPerfRowTable() as Table<EncPerfRow>;
const db = new Db(spannerDriver, undefined, new TransactionContext());

/**
 * Performance sanity for the doc's claims (TRUST_AND_COMPLIANCE §1.5): per-value AES-256-GCM
 * decrypt ~1-3µs in Node; a 1k-row read's decrypt overhead an order of magnitude below the
 * database/network latency the read already pays. Numbers are printed for the report.
 */
describe('Column encryption performance sanity', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const tableManager = spannerDriver.getTableManager();

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    registerTestUser();
    setDbEncryptionConfig({
      masterKeyProvider: new InMemoryMasterKeyProvider('column-encryption-test'),
      getAccessibleKeyOwners: async () => [OWNER],
    });
    await loadColumnEncryptionTestSchema(tableManager, [encTable, plainTable]);
    await purgeColumnEncryptionTestRows(spannerDriver, [encTable, plainTable]);

    // Seed 1k rows in each table with identical ~120-char bodies (batched inserts via txns
    // to keep seeding fast on the emulator).
    const body = (index: number) =>
      `note body ${index} — a sentence of ordinary length, the kind a document row actually stores in practice.`;
    for (let batch = 0; batch < ROW_COUNT / 100; batch++) {
      await db.runTransaction(async () => {
        for (let i = 0; i < 100; i++) {
          const index = batch * 100 + i;
          await db.insert(encTable, { scope: OWNER, body: body(index) });
        }
      });
      await db.runTransaction(async () => {
        for (let i = 0; i < 100; i++) {
          const index = batch * 100 + i;
          await db.insert(plainTable, { scope: OWNER, body: body(index) });
        }
      });
    }
  }, 600000);

  afterAll(async () => {
    setDbEncryptionConfig(undefined);
    clearTestUser();
    await dropTable(encTable);
    await dropTable(plainTable);
    await SpannerEmulatorProvisioner.release();
  }, 120000);

  const timeQuery = async (table: Table<EncPerfRow>): Promise<{ ms: number; rows: number }> => {
    const start = process.hrtime.bigint();
    const rows = await db.query(
      table,
      new QueryBuilder<EncPerfRow>(table.name).condition({ field: 'scope', operator: '=', value: OWNER })
    );
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    return { ms, rows: rows.length };
  };

  test('1k-row read: decrypt overhead measured against the plaintext twin', async () => {
    // warm the key cache + driver sessions
    await timeQuery(encTable);
    await timeQuery(plainTable);

    const samples = 5;
    let encTotal = 0;
    let plainTotal = 0;
    for (let i = 0; i < samples; i++) {
      encTotal += (await timeQuery(encTable)).ms;
      plainTotal += (await timeQuery(plainTable)).ms;
    }
    const encAvg = encTotal / samples;
    const plainAvg = plainTotal / samples;
    const overheadMs = encAvg - plainAvg;
    const perValueUs = (overheadMs * 1000) / ROW_COUNT;

    // eslint-disable-next-line no-console
    console.info(
      `[perf] 1k-row read: encrypted ${encAvg.toFixed(1)}ms vs plaintext ${plainAvg.toFixed(1)}ms — ` +
        `decrypt overhead ${overheadMs.toFixed(1)}ms total, ~${perValueUs.toFixed(2)}µs/value (doc claim: ~1-3µs/value)`
    );

    const encRows = await db.query(
      encTable,
      new QueryBuilder<EncPerfRow>(encTable.name).condition({ field: 'scope', operator: '=', value: OWNER })
    );
    expect(encRows.length).toBe(ROW_COUNT);
    // Sanity bound, generous (emulator variance): the whole-read overhead stays well under
    // the read itself — decrypt must not dominate.
    expect(overheadMs).toBeLessThan(Math.max(plainAvg, 250));
  });

  test('per-value decrypt microbenchmark: the in-process AES-256-GCM cost itself', async () => {
    const key = await new DataKeyStore().getWriteKey(OWNER);
    const envelope = new EncryptionEnvelope();
    const value = 'note body — a sentence of ordinary length, the kind a document row actually stores in practice.';
    const encrypted = envelope.encrypt(value, key);

    const iterations = 10000;
    // warm
    for (let i = 0; i < 1000; i++) {
      envelope.decrypt(encrypted, key);
    }
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      envelope.decrypt(encrypted, key);
    }
    const totalUs = Number(process.hrtime.bigint() - start) / 1e3;
    const perValueUs = totalUs / iterations;

    // eslint-disable-next-line no-console
    console.info(
      `[perf] in-process decrypt: ${perValueUs.toFixed(2)}µs/value over ${iterations} iterations ` +
        `(doc claim: ~1-3µs/value)`
    );

    expect(envelope.decrypt(encrypted, key)).toBe(value);
    // The claim's order of magnitude, with generous headroom for slow machines
    expect(perValueUs).toBeLessThan(30);
  });
});
