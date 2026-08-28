import {
  Db,
  Table,
  setDbEncryptionConfig,
  InMemoryMasterKeyProvider,
  EncryptedColumns,
  EncryptedColumnQueryError,
  QueryBuilder,
} from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import { EncSortedItem, EncSortedItemTable, EncUniqueTag, EncUniqueTagTable } from './util/columnEncryptionTestTables';
import { loadColumnEncryptionTestSchema, purgeColumnEncryptionTestRows } from './util/columnEncryptionTestHarness';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import '../generated/test/index';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

(globalThis as any)['__proteinjs_db_defaultDbDriver'] = spannerDriver;

const OWNER_A = 'enc-sort-owner-a';
const OWNER_B = 'enc-sort-owner-b';

const sortedTable = new EncSortedItemTable() as Table<EncSortedItem>;
const uniqueTable = new EncUniqueTagTable() as Table<EncUniqueTag>;
const db = new Db(spannerDriver, undefined, new TransactionContext());

/**
 * The sortKey tier of the sorting story (a DECLARED bounded reveal → native ORDER BY at any
 * scale), the loud live rejection without one, and value uniqueness through the equality
 * fingerprint (per owner).
 */
describe('Encrypted sortKey ORDER BY + fingerprint uniqueness', () => {
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
      getAccessibleKeyOwners: async () => [OWNER_A],
    });
    await loadColumnEncryptionTestSchema(tableManager, [sortedTable, uniqueTable]);
    await purgeColumnEncryptionTestRows(spannerDriver, [sortedTable, uniqueTable]);
  }, 120000);

  afterAll(async () => {
    setDbEncryptionConfig(undefined);
    clearTestUser();
    await dropTable(new EncryptedColumns().tokenTableFor(sortedTable)!);
    await dropTable(sortedTable);
    await dropTable(uniqueTable);
    await SpannerEmulatorProvisioner.release();
  }, 120000);

  test('sortKey: native ORDER BY + sorted pagination over encrypted values; only the declared prefix is revealed at rest', async () => {
    const titles = ['banana bread', 'Apple pie', 'cherry tart', 'apricot jam', 'Blueberry scone'];
    const ids: string[] = [];
    for (const title of titles) {
      ids.push((await db.insert(sortedTable, { scope: OWNER_A, title })).id);
    }

    // native DB-side ORDER BY on the encrypted column (revealPrefix=3 buckets), ascending
    const sorted = await db.query(
      sortedTable,
      new QueryBuilder<EncSortedItem>(sortedTable.name)
        .condition({ field: 'scope', operator: '=', value: OWNER_A })
        .sort([{ field: 'title' }])
    );
    const sortedTitles = sorted.map((row) => row.title);
    // prefix buckets (first 3 chars, normalized): app=Apple/apricot tie-break within bucket,
    // then ban, blu, che — assert bucket ORDER, the declared guarantee
    const buckets = sortedTitles.map((title) => (title ?? '').toLowerCase().slice(0, 3));
    expect(buckets).toEqual([...buckets].sort());

    // sorted PAGINATION: the first page of the prefix order
    const firstPage = await db.query(
      sortedTable,
      new QueryBuilder<EncSortedItem>(sortedTable.name)
        .condition({ field: 'scope', operator: '=', value: OWNER_A })
        .sort([{ field: 'title' }])
        .paginate({ start: 0, end: 2 })
    );
    expect(firstPage.length).toBe(2);
    for (const row of firstPage) {
      expect((row.title ?? '').toLowerCase().slice(0, 2)).toBe('ap');
    }

    // at rest: the sort companion holds EXACTLY the declared 3-character reveal
    const raw = await spannerDriver.runQuery(() => ({
      sql: `SELECT \`title\`, \`title_enc_srt\` FROM \`${sortedTable.name}\` WHERE \`id\` = '${ids[0]}'`,
    }));
    expect((raw[0] as any).title_enc_srt).toBe('ban');
    expect((raw[0] as any).title).not.toContain('banana');

    for (const id of ids) {
      await db.delete(sortedTable, { id });
    }
  });

  test('the live loud rejection: ORDER BY an encrypted column with no sortKey throws at query-build time', async () => {
    const tagQb = new QueryBuilder<EncUniqueTag>(uniqueTable.name).sort([{ field: 'name' }]);
    await expect(db.query(uniqueTable, tagQb)).rejects.toThrow(EncryptedColumnQueryError);

    const tagQb2 = new QueryBuilder<EncUniqueTag>(uniqueTable.name).sort([{ field: 'name' }]);
    await expect(db.query(uniqueTable, tagQb2)).rejects.toThrow(/no sortKey declared/);
  });

  test('uniqueness on the value rides the fingerprint: duplicate value for the same owner rejected; other owners unaffected', async () => {
    const first = await db.insert(uniqueTable, { scope: OWNER_A, name: 'oncologist' });
    await expect(db.insert(uniqueTable, { scope: OWNER_A, name: 'oncologist' })).rejects.toThrow();

    // per-owner semantics: another owner may hold the same value (fingerprints are keyed per owner)
    const otherOwner = await db.insert(uniqueTable, { scope: OWNER_B, name: 'oncologist' });

    await db.delete(uniqueTable, { id: first.id });
    await db.delete(uniqueTable, { id: otherOwner.id });
  });
});
