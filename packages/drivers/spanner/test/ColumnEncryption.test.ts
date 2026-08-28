import {
  Db,
  Table,
  setDbEncryptionConfig,
  InMemoryMasterKeyProvider,
  DataKeyStore,
  EncryptionEnvelope,
  EncryptionKeyUnavailableError,
  MasterKeyProvider,
  QueryBuilder,
} from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import { EncNote, EncNoteTable } from './util/columnEncryptionTestTables';
import { loadColumnEncryptionTestSchema, purgeColumnEncryptionTestRows } from './util/columnEncryptionTestHarness';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import '../generated/test/index';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

/** Key IO (DataKeyStore) rides the process's default driver — the getDbAsSystem idiom the
 *  migration ledger already uses. The driver test harness has no DefaultDbDriverFactory, so
 *  seed the global the same way the factory would (test-harness convention: runtime access
 *  to internals rather than widening the API). */
(globalThis as any)['__proteinjs_db_defaultDbDriver'] = spannerDriver;

const OWNER_A = 'enc-core-owner-a';
const OWNER_B = 'enc-core-owner-b';

/** Counts vault calls, so unwrap-once caching is asserted on OUTCOMES (vault traffic). */
class CountingMasterKeyProvider implements MasterKeyProvider {
  public wrapCalls = 0;
  public unwrapCalls = 0;
  private delegate = new InMemoryMasterKeyProvider('column-encryption-test');

  async wrapDataKey(material: Buffer): Promise<string> {
    this.wrapCalls++;
    return await this.delegate.wrapDataKey(material);
  }

  async unwrapDataKey(wrapped: string): Promise<Buffer> {
    this.unwrapCalls++;
    return await this.delegate.unwrapDataKey(wrapped);
  }

  getMasterKeyId(): string {
    return 'counting-in-memory';
  }
}

const masterKeyProvider = new CountingMasterKeyProvider();
let accessibleOwners: string[] = [OWNER_A];

const noteTable = new EncNoteTable() as Table<EncNote>;
const db = new Db(spannerDriver, undefined, new TransactionContext());
const envelope = new EncryptionEnvelope();

const rawColumn = async (tableName: string, id: string, columnName: string): Promise<any> => {
  const rows = await spannerDriver.runQuery(() => ({
    sql: `SELECT \`${columnName}\` FROM \`${tableName}\` WHERE \`id\` = '${id}'`,
  }));
  return rows[0]?.[columnName];
};

describe('Column encryption: the transparent seam', () => {
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
      masterKeyProvider,
      getAccessibleKeyOwners: async () => accessibleOwners,
    });
    await loadColumnEncryptionTestSchema(tableManager, [noteTable]);
    await purgeColumnEncryptionTestRows(spannerDriver, [noteTable]);
  }, 120000);

  afterAll(async () => {
    setDbEncryptionConfig(undefined);
    clearTestUser();
    const { EncryptedColumns } = await import('@proteinjs/db');
    await dropTable(new EncryptedColumns().tokenTableFor(noteTable)!);
    await dropTable(noteTable);
    await SpannerEmulatorProvisioner.release();
  }, 60000);

  beforeEach(() => {
    accessibleOwners = [OWNER_A];
  });

  test('round trip is transparent: callers write and read plaintext; the database stores a ciphertext envelope', async () => {
    const inserted = await db.insert(noteTable, {
      scope: OWNER_A,
      title: 'Therapy notes — divorce',
      label: 'personal',
      body: 'The most sensitive words in the account.',
      status: 'active',
    });

    // Caller-visible: plaintext, unchanged API
    const fetched = await db.get(noteTable, { id: inserted.id });
    expect(fetched.title).toBe('Therapy notes — divorce');
    expect(fetched.label).toBe('personal');
    expect(fetched.body).toBe('The most sensitive words in the account.');
    expect(fetched.status).toBe('active');

    // At rest: self-describing envelopes, no plaintext, plaintext column untouched
    for (const columnName of ['title', 'label', 'body']) {
      const stored = await rawColumn(noteTable.name, inserted.id, columnName);
      expect(envelope.isEnvelope(stored)).toBe(true);
      expect(stored).not.toContain('divorce');
      expect(stored).not.toContain('sensitive');
      const parsed = envelope.parse(stored)!;
      expect(parsed.owner).toBe(OWNER_A);
    }
    expect(await rawColumn(noteTable.name, inserted.id, 'status')).toBe('active');

    // Deserialized records carry no framework companion columns
    expect(Object.keys(fetched).some((key) => key.includes('__enc'))).toBe(false);

    await db.delete(noteTable, { id: inserted.id });
  });

  test('update through the seam: new ciphertext at rest, plaintext to callers', async () => {
    const inserted = await db.insert(noteTable, { scope: OWNER_A, title: 'Before', label: 'a', body: 'b' });
    const updateCount = await db.update(noteTable, { id: inserted.id, title: 'After the update' });
    expect(updateCount).toBe(1);

    const fetched = await db.get(noteTable, { id: inserted.id });
    expect(fetched.title).toBe('After the update');
    expect(fetched.label).toBe('a'); // untouched columns survive

    const stored = await rawColumn(noteTable.name, inserted.id, 'title');
    expect(envelope.isEnvelope(stored)).toBe(true);
    expect(stored).not.toContain('After');

    await db.delete(noteTable, { id: inserted.id });
  });

  test('null stays null: IS NULL / IS NOT NULL queries keep working natively', async () => {
    const withTitle = await db.insert(noteTable, { scope: OWNER_A, title: 'present', label: 'x', body: null });
    const withoutTitle = await db.insert(noteTable, { scope: OWNER_A, title: null, label: 'y', body: 'here' });

    expect(await rawColumn(noteTable.name, withoutTitle.id, 'title')).toBeNull();

    const nullTitles = await db.query(
      noteTable,
      new QueryBuilder<EncNote>(noteTable.name).condition({ field: 'title', operator: 'IS NULL' })
    );
    expect(nullTitles.some((row) => row.id === withoutTitle.id)).toBe(true);
    expect(nullTitles.some((row) => row.id === withTitle.id)).toBe(false);

    await db.delete(noteTable, { id: withTitle.id });
    await db.delete(noteTable, { id: withoutTitle.id });
  });

  test('adoption path: a pre-encryption plaintext row reads through the seam unchanged', async () => {
    const id = 'enc-adoption-row-1';
    await spannerDriver.runDml(() => ({
      sql:
        `INSERT INTO \`${noteTable.name}\` (\`id\`, \`created\`, \`updated\`, \`scope\`, \`title\`, \`status\`) ` +
        `VALUES ('${id}', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), '${OWNER_A}', 'legacy plaintext title', 'active')`,
    }));

    const fetched = await db.get(noteTable, { id });
    expect(fetched.title).toBe('legacy plaintext title');
    await db.delete(noteTable, { id });
  });

  test('scope-owner keying: each row encrypts under its scope owner; the vault is called once per key (unwrap caching)', async () => {
    const rowA = await db.insert(noteTable, { scope: OWNER_A, title: 'a note', label: 'la', body: 'ba' });
    const rowB = await db.insert(noteTable, { scope: OWNER_B, title: 'b note', label: 'lb', body: 'bb' });

    expect(envelope.parse(await rawColumn(noteTable.name, rowA.id, 'title'))!.owner).toBe(OWNER_A);
    expect(envelope.parse(await rawColumn(noteTable.name, rowB.id, 'title'))!.owner).toBe(OWNER_B);

    // Server-side sharing mechanics: decrypt resolves the key FROM the envelope, so one
    // reader's reads return both owners' rows decrypted.
    const bothRows = [await db.get(noteTable, { id: rowA.id }), await db.get(noteTable, { id: rowB.id })];
    expect(bothRows.map((row) => row.title)).toEqual(['a note', 'b note']);

    // Unwrap-once caching: repeat reads add ZERO vault calls
    const unwrapCallsBefore = masterKeyProvider.unwrapCalls;
    for (let i = 0; i < 5; i++) {
      await db.get(noteTable, { id: rowA.id });
      await db.get(noteTable, { id: rowB.id });
    }
    expect(masterKeyProvider.unwrapCalls).toBe(unwrapCallsBefore);

    await db.delete(noteTable, { id: rowA.id });
    await db.delete(noteTable, { id: rowB.id });
  });

  test('a shared-scope row keys by the scope owner, not the writer: config resolveKeyOwner decides', async () => {
    setDbEncryptionConfig({
      masterKeyProvider,
      getAccessibleKeyOwners: async () => accessibleOwners,
      // The consumer's scope→owner mapping (thought-common's permission-source resolver in
      // the app): here, rows whose scope starts with 'shared:' belong to OWNER_B.
      resolveKeyOwner: async ({ record }) =>
        typeof record.scope === 'string' && record.scope.startsWith('shared:') ? OWNER_B : undefined,
    });

    const sharedRow = await db.insert(noteTable, { scope: 'shared:tree-root', title: 'contributed text', label: 'l' });
    expect(envelope.parse(await rawColumn(noteTable.name, sharedRow.id, 'title'))!.owner).toBe(OWNER_B);

    await db.delete(noteTable, { id: sharedRow.id });
    setDbEncryptionConfig({ masterKeyProvider, getAccessibleKeyOwners: async () => accessibleOwners });
  });

  test('crypto-shred: deleting an owner key makes their rows permanently unreadable, loudly', async () => {
    const shredOwner = 'enc-core-shred-owner';
    const row = await db.insert(noteTable, { scope: shredOwner, title: 'to be shredded', label: 'x', body: 'y' });

    const deleted = await new DataKeyStore().shredOwnerKeys(shredOwner);
    expect(deleted).toBeGreaterThanOrEqual(1);

    await expect(db.get(noteTable, { id: row.id })).rejects.toThrow(EncryptionKeyUnavailableError);

    // other owners' rows are untouched (blast radius = one owner)
    const survivor = await db.insert(noteTable, { scope: OWNER_A, title: 'still fine', label: 'ok' });
    expect((await db.get(noteTable, { id: survivor.id })).title).toBe('still fine');

    await spannerDriver.runDml(() => ({
      sql: `DELETE FROM \`${noteTable.name}\` WHERE \`id\` = '${row.id}'`,
    }));
    await db.delete(noteTable, { id: survivor.id });
  });

  test('transactions: encrypted writes and reads ride runTransaction like any other write', async () => {
    const result = await db.runTransaction(async () => {
      const inserted = await db.insert(noteTable, { scope: OWNER_A, title: 'txn title', label: 'txn' });
      await db.update(noteTable, { id: inserted.id, body: 'txn body' });
      return await db.get(noteTable, { id: inserted.id });
    });
    expect(result.title).toBe('txn title');
    expect(result.body).toBe('txn body');
    await db.delete(noteTable, { id: result.id });
  });
});
