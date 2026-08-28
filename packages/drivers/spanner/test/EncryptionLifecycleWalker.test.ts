import {
  Db,
  Record,
  StringColumn,
  Table,
  withRecordColumns,
  setDbEncryptionConfig,
  InMemoryMasterKeyProvider,
  DataKeyStore,
  EncryptedColumns,
  EncryptionEnvelope,
  EncryptionLifecycleWalker,
  QueryBuilder,
} from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import { EncWalkRow, EncWalkRowTable } from './util/columnEncryptionTestTables';
import { loadColumnEncryptionTestSchema, purgeColumnEncryptionTestRows } from './util/columnEncryptionTestHarness';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import '../generated/test/index';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

(globalThis as any)['__proteinjs_db_defaultDbDriver'] = spannerDriver;

const OWNER = 'enc-walk-owner-a';

const walkTable = new EncWalkRowTable() as Table<EncWalkRow>;
const db = new Db(spannerDriver, undefined, new TransactionContext());
const systemDb = new Db(spannerDriver, undefined, new TransactionContext(), true);
const envelope = new EncryptionEnvelope();
const walker = new EncryptionLifecycleWalker();

/**
 * The decrypt-out view of the walk table: the SAME physical table with the columns declared
 * plaintext — how the schema looks after a deliberate reclassification flips the config.
 * Deliberately NOT a registered loadable (the registry holds the encrypted declaration;
 * name-based lookups only resolve column names/types, identical between the two).
 */
class EncWalkRowDecryptedView extends Table<EncWalkRow> {
  name = 'db_test_enc_walk_row';
  columns: Table<EncWalkRow>['columns'] = withRecordColumns<EncWalkRow>({
    scope: new StringColumn('scope', {}, 36),
    title: new StringColumn('title', { encrypted: false }, 'MAX'),
    body: new StringColumn('body', { encrypted: false }, 'MAX'),
  });
}

const rawRows = async (): Promise<any[]> =>
  await spannerDriver.runQuery(() => ({
    sql: `SELECT \`id\`, \`title\`, \`body\` FROM \`${walkTable.name}\` ORDER BY \`id\``,
  }));

const seedPlaintextRow = async (id: string, title: string, body: string) => {
  await spannerDriver.runDml(() => ({
    sql:
      `INSERT INTO \`${walkTable.name}\` (\`id\`, \`created\`, \`updated\`, \`scope\`, \`title\`, \`body\`) ` +
      `VALUES ('${id}', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), '${OWNER}', '${title}', '${body}')`,
  }));
};

const titleLike = (pattern: string) =>
  new QueryBuilder<EncWalkRow>(walkTable.name).condition({ field: 'title', operator: 'LIKE', value: pattern });

/**
 * The one reusable ONLINE backfill behind every config transition (encrypt-in-place
 * adoption, add-searchable tokenization, decrypt-out, key rotation) — idempotent,
 * resumable, migration-runner-shaped.
 */
describe('Encryption lifecycle walker', () => {
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
    await loadColumnEncryptionTestSchema(tableManager, [walkTable]);
    await purgeColumnEncryptionTestRows(spannerDriver, [walkTable]);
  }, 120000);

  afterAll(async () => {
    setDbEncryptionConfig(undefined);
    clearTestUser();
    await dropTable(new EncryptedColumns().tokenTableFor(walkTable)!);
    await dropTable(walkTable);
    await SpannerEmulatorProvisioner.release();
  }, 120000);

  afterEach(async () => {
    await spannerDriver.runDml(() => ({ sql: `DELETE FROM \`${walkTable.name}\` WHERE TRUE` }));
    const tokenTable = new EncryptedColumns().tokenTableFor(walkTable)!;
    await spannerDriver.runDml(() => ({ sql: `DELETE FROM \`${tokenTable.name}\` WHERE TRUE` }));
  });

  test('encrypt-in-place adoption: plaintext rows become envelopes, search works, live rows are skipped (idempotence)', async () => {
    // the pre-encryption estate
    await seedPlaintextRow('walk-adopt-1', 'meeting notes alpha', 'body one');
    await seedPlaintextRow('walk-adopt-2', 'meeting notes beta', 'body two');
    await seedPlaintextRow('walk-adopt-3', 'unrelated title', 'body three');
    // a row already written through the live seam (already encrypted)
    const liveRow = await db.insert(walkTable, { scope: OWNER, title: 'live row gamma', body: 'live body' });

    const summary = await walker.walkTable(walkTable, 'encrypt', {
      dbDriver: spannerDriver,
      db: systemDb,
      windowSize: 2, // exercise multi-window cursor paging
    });
    expect(summary.scanned).toBe(4);
    expect(summary.rewritten).toBe(3); // the three plaintext rows; the live row skipped

    // all rows now ciphertext at rest
    for (const raw of await rawRows()) {
      expect(envelope.isEnvelope(raw.title)).toBe(true);
      expect(envelope.isEnvelope(raw.body)).toBe(true);
    }

    // the adopted rows are searchable (tokens were written by the rewrite)
    const found = await db.query(walkTable, titleLike('%meeting notes%'));
    expect(found.map((row) => row.title).sort()).toEqual(['meeting notes alpha', 'meeting notes beta']);

    // and values still read back exactly
    expect((await db.get(walkTable, { id: 'walk-adopt-1' })).body).toBe('body one');

    // IDEMPOTENCE: a re-run rewrites nothing
    const rerun = await walker.walkTable(walkTable, 'encrypt', { dbDriver: spannerDriver, db: systemDb });
    expect(rerun.scanned).toBe(4);
    expect(rerun.rewritten).toBe(0);

    void liveRow;
  });

  test('resumability: a walk resumed from a cursor completes the remainder; done rows stay done', async () => {
    await seedPlaintextRow('walk-resume-1', 'resume one', 'b');
    await seedPlaintextRow('walk-resume-2', 'resume two', 'b');
    await seedPlaintextRow('walk-resume-3', 'resume three', 'b');

    // "crash" after the first row: simulate by walking only rows after a cursor — then
    // verify a fresh full run converges the rest without redoing done work
    const partial = await walker.walkTable(walkTable, 'encrypt', {
      dbDriver: spannerDriver,
      db: systemDb,
      startAfterId: 'walk-resume-1',
    });
    expect(partial.rewritten).toBe(2);

    const finish = await walker.walkTable(walkTable, 'encrypt', { dbDriver: spannerDriver, db: systemDb });
    expect(finish.rewritten).toBe(1); // only the row the partial walk never reached

    for (const raw of await rawRows()) {
      expect(envelope.isEnvelope(raw.title)).toBe(true);
    }
  });

  test('decrypt-out reclassification: envelopes become plaintext, token rows are swept', async () => {
    await db.insert(walkTable, { scope: OWNER, title: 'soon public alpha', body: 'body a' });
    await db.insert(walkTable, { scope: OWNER, title: 'soon public beta', body: 'body b' });

    const decryptedView = new EncWalkRowDecryptedView() as Table<EncWalkRow>;
    const summary = await walker.walkTable(decryptedView, 'decrypt', {
      dbDriver: spannerDriver,
      db: systemDb,
      columns: ['title', 'body'],
    });
    expect(summary.rewritten).toBe(2);

    for (const raw of await rawRows()) {
      expect(envelope.isEnvelope(raw.title)).toBe(false);
      expect(raw.title).toContain('soon public');
    }

    const tokenTable = new EncryptedColumns().tokenTableFor(walkTable)!;
    const tokenCount = await spannerDriver.runQuery(() => ({
      sql: `SELECT COUNT(*) as tokenCount FROM \`${tokenTable.name}\``,
    }));
    expect(Number((tokenCount[0] as any).tokenCount)).toBe(0);
  });

  test('key rotation: rotate mints a new version, the walk rewrites envelopes to it, search stays exact, old version retires', async () => {
    const row1 = await db.insert(walkTable, { scope: OWNER, title: 'rotation subject one', body: 'rb1' });
    const row2 = await db.insert(walkTable, { scope: OWNER, title: 'rotation subject two', body: 'rb2' });

    const store = new DataKeyStore();
    const versionBefore = envelope.parse((await rawRows())[0].title)!.version;
    const newVersion = await store.rotateKey(OWNER);
    expect(newVersion).toBe(versionBefore + 1);

    // during the rotation window (before the walk), reads and search still work
    expect((await db.get(walkTable, { id: row1.id })).title).toBe('rotation subject one');
    expect((await db.query(walkTable, titleLike('%rotation subject%'))).length).toBe(2);

    const summary = await walker.walkTable(walkTable, 'rotate-keys', { dbDriver: spannerDriver, db: systemDb });
    expect(summary.rewritten).toBe(2);

    for (const raw of await rawRows()) {
      expect(envelope.parse(raw.title)!.version).toBe(newVersion);
      expect(envelope.parse(raw.body)!.version).toBe(newVersion);
    }

    // idempotence: nothing left at the old version
    const rerun = await walker.walkTable(walkTable, 'rotate-keys', { dbDriver: spannerDriver, db: systemDb });
    expect(rerun.rewritten).toBe(0);

    // retire the old version: reads and search remain exact on the new key
    await store.retireKeyVersion(OWNER, versionBefore);
    expect((await db.get(walkTable, { id: row2.id })).title).toBe('rotation subject two');
    const found = await db.query(walkTable, titleLike('%rotation subject%'));
    expect(found.length).toBe(2);
  });
});
