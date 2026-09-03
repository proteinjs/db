import {
  DataKeyStore,
  Db,
  EncryptedColumns,
  EncryptionEnvelope,
  EncryptionLifecycleWalker,
  InMemoryMasterKeyProvider,
  LeafEnvelopeCodec,
  LeafPaths,
  QueryBuilder,
  Table,
  setDbEncryptionConfig,
} from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import { EncLeafDoc, EncLeafDocTable } from './util/columnEncryptionTestTables';
import { loadColumnEncryptionTestSchema, purgeColumnEncryptionTestRows } from './util/columnEncryptionTestHarness';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import '../generated/test/index';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

(globalThis as any)['__proteinjs_db_defaultDbDriver'] = spannerDriver;

const OWNER = 'enc-leaf-owner-a';
const ENC = LeafEnvelopeCodec.ENC_KEY;
const ARR = LeafEnvelopeCodec.ARRAY_WRAPPER_KEY;

const leafTable = new EncLeafDocTable() as Table<EncLeafDoc>;
const db = new Db(spannerDriver, undefined, new TransactionContext());
const systemDb = new Db(spannerDriver, undefined, new TransactionContext(), true);
const envelope = new EncryptionEnvelope();
const walker = new EncryptionLifecycleWalker();
type WalkerInternals = { interposeBeforeRewrite?: (id: string) => Promise<void> };

/** The stored JSON document (parsed) of one row's column, straight off the driver — never through the seam. */
const rawJson = async (id: string, column: 'doc' | 'sources' | 'blob'): Promise<any> => {
  const rows = await spannerDriver.runQuery(() => ({
    sql: `SELECT \`${column}\` FROM \`${leafTable.name}\` WHERE \`id\` = '${id}'`,
  }));
  const value = rows[0]?.[column];
  return typeof value === 'string' ? JSON.parse(value) : value;
};

const rawJsonValue = async (id: string, column: string, path: string): Promise<string | null> => {
  const rows = await spannerDriver.runQuery(() => ({
    sql: `SELECT JSON_VALUE(\`${column}\`, '${path}') AS v FROM \`${leafTable.name}\` WHERE \`id\` = '${id}'`,
  }));
  return rows[0]?.v ?? null;
};

/** A pre-encryption row: plaintext JSON written raw, the way every production row looks before the backfill. */
const seedPlaintextRow = async (id: string, kind: string | null, doc: object) => {
  await spannerDriver.runDml(() => ({
    sql:
      `INSERT INTO \`${leafTable.name}\` (\`id\`, \`created\`, \`updated\`, \`scope\`, \`kind\`, \`doc\`) ` +
      `VALUES ('${id}', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), '${OWNER}', ${kind === null ? 'NULL' : `'${kind}'`}, ` +
      `JSON '${JSON.stringify(doc).replace(/'/g, "\\'")}')`,
  }));
};

/**
 * Leaf envelopes on a JSON column (ENCRYPTED_THOUGHT_OBJECT §4): the words inside a document
 * are ciphertext at rest, the shape and declared facts stay plaintext and queryable with
 * Spanner's JSON functions, reads need no policy, and every lifecycle transition (adoption,
 * update-by-id under the stored type, rotation, decrypt-out rollback, the walker's
 * read-modify-write) holds per leaf.
 */
describe('Leaf-encrypted JSON columns', () => {
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
      masterKeyProvider: new InMemoryMasterKeyProvider('leaf-encryption-test'),
      getAccessibleKeyOwners: async () => [OWNER],
    });
    await loadColumnEncryptionTestSchema(tableManager, [leafTable]);
    await purgeColumnEncryptionTestRows(spannerDriver, [leafTable]);
  }, 120000);

  afterAll(async () => {
    setDbEncryptionConfig(undefined);
    clearTestUser();
    await dropTable(leafTable);
    await SpannerEmulatorProvisioner.release();
  }, 120000);

  afterEach(async () => {
    (walker as unknown as WalkerInternals).interposeBeforeRewrite = undefined;
    await spannerDriver.runDml(() => ({ sql: `DELETE FROM \`${leafTable.name}\` WHERE TRUE` }));
  });

  test('a document writes with its words as envelopes and its shape/facts as plaintext JSON; JSON_VALUE answers on facts; the read is the original object', async () => {
    const doc = {
      content: 'the words inside',
      type: 'h2',
      fontSize: 24,
      bold: true,
      nested: { note: 'more words', count: 3 },
    };
    const row = await db.insert(leafTable, { scope: OWNER, kind: null, doc });

    const stored = await rawJson(row.id, 'doc');
    expect(envelope.isEnvelope(stored.content)).toBe(true);
    expect(envelope.isEnvelope(stored.nested.note)).toBe(true);
    expect(stored.type).toBe('h2');
    expect(stored.fontSize).toBe(24);
    expect(stored.bold).toBe(true);
    expect(stored.nested.count).toBe(3);
    expect(JSON.stringify(stored)).not.toContain('words');
    expect(envelope.parse(stored.content)?.owner).toBe(OWNER);

    // The column is still a JSON document to Spanner: facts are readable and filterable DB-side.
    expect(await rawJsonValue(row.id, 'doc', '$.type')).toBe('h2');
    expect(await rawJsonValue(row.id, 'doc', '$.fontSize')).toBe('24');
    const byFact = await spannerDriver.runQuery(() => ({
      sql: `SELECT \`id\` FROM \`${leafTable.name}\` WHERE JSON_VALUE(\`doc\`, '$.type') = 'h2'`,
    }));
    expect(byFact.map((r: any) => r.id)).toEqual([row.id]);

    expect((await db.get(leafTable, { id: row.id })).doc).toEqual(doc);
  });

  test('the per-row policy: a trip row keeps its declared facts plaintext, a default row envelopes the same keys', async () => {
    const trip = await db.insert(leafTable, {
      scope: OWNER,
      kind: 'trip',
      doc: { content: 'Summit trip', type: 'h1', state: 'planned', start: '2026-10-04', origin: 'SEA', budget: 4500 },
    });
    const plain = await db.insert(leafTable, {
      scope: OWNER,
      kind: 'note',
      doc: { content: 'A note', type: 'body1', state: 'planned', start: '2026-10-04' },
    });

    const tripStored = await rawJson(trip.id, 'doc');
    expect(tripStored.state).toBe('planned');
    expect(tripStored.start).toBe('2026-10-04');
    expect(tripStored.budget).toBe(4500);
    expect(envelope.isEnvelope(tripStored.origin)).toBe(true);
    expect(envelope.isEnvelope(tripStored.content)).toBe(true);
    expect(await rawJsonValue(trip.id, 'doc', '$.state')).toBe('planned');

    const plainStored = await rawJson(plain.id, 'doc');
    expect(envelope.isEnvelope(plainStored.state)).toBe(true);
    expect(envelope.isEnvelope(plainStored.start)).toBe(true);
    expect(plainStored.type).toBe('body1');
  });

  test('G1: update({ id, doc }) with no discriminator lands under the STORED row policy; a payload discriminator wins on a switch', async () => {
    const trip = await db.insert(leafTable, {
      scope: OWNER,
      kind: 'trip',
      doc: { content: 'Summit trip', type: 'h1', state: 'planned' },
    });

    // The editor's save shape: id + document, nothing else.
    await db.update(leafTable, { id: trip.id, doc: { content: 'Summit trip, revised', type: 'h1', state: 'booked' } });
    const afterSave = await rawJson(trip.id, 'doc');
    expect(afterSave.state).toBe('booked');
    expect(envelope.isEnvelope(afterSave.content)).toBe(true);
    expect((await db.get(leafTable, { id: trip.id })).doc.content).toBe('Summit trip, revised');

    // A type switch carried by the payload re-classifies the same keys under the new policy.
    await db.update(leafTable, { id: trip.id, kind: 'note', doc: { content: 'Now a note', type: 'body1', state: 'booked' } });
    const afterSwitch = await rawJson(trip.id, 'doc');
    expect(envelope.isEnvelope(afterSwitch.state)).toBe(true);
    expect((await db.get(leafTable, { id: trip.id })).doc).toEqual({ content: 'Now a note', type: 'body1', state: 'booked' });
  });

  test('a multi-row update across two kinds lands each row under its own policy', async () => {
    const trip = await db.insert(leafTable, { scope: OWNER, kind: 'trip', doc: { content: 'a', state: 'planned' } });
    const note = await db.insert(leafTable, { scope: OWNER, kind: 'note', doc: { content: 'b', state: 'planned' } });

    const qb = new QueryBuilder<EncLeafDoc>(leafTable.name).condition({
      field: 'id',
      operator: 'IN',
      value: [trip.id, note.id],
    });
    const count = await db.update(leafTable, { doc: { content: 'both', state: 'booked' } }, qb);
    expect(count).toBe(2);
    expect((await rawJson(trip.id, 'doc')).state).toBe('booked');
    expect(envelope.isEnvelope((await rawJson(note.id, 'doc')).state)).toBe(true);
    expect((await db.get(leafTable, { id: note.id })).doc).toEqual({ content: 'both', state: 'booked' });
  });

  test('whole-value and ids-skeleton policies: one envelope object for `blob`; per-entry envelopes with plaintext ids for `sources` (array wrapper intact)', async () => {
    const blob = { steps: ['think', 'plan'], why: 'reasons', depth: 2 };
    const sources = [
      { id: 's1', url: 'https://a.test/x', title: 'A' },
      { id: 's2', url: 'https://b.test/y' },
    ];
    const row = await db.insert(leafTable, { scope: OWNER, kind: null, blob, sources });

    const storedBlob = await rawJson(row.id, 'blob');
    expect(Object.keys(storedBlob)).toEqual([ENC]);
    expect(JSON.stringify(storedBlob)).not.toContain('reasons');

    const storedSources = await rawJson(row.id, 'sources');
    expect(Object.keys(storedSources)).toEqual([ARR]);
    expect(storedSources[ARR].map((entry: any) => entry.id)).toEqual(['s1', 's2']);
    expect(Object.keys(storedSources[ARR][0]).sort()).toEqual([ENC, 'id']);
    expect(JSON.stringify(storedSources)).not.toContain('a.test');
    // IS NULL / cardinality stay answerable: the array is still an array to Spanner.
    expect(await rawJsonValue(row.id, 'sources', `$.${ARR}[1].id`)).toBe('s2');

    const back = await db.get(leafTable, { id: row.id });
    expect(back.blob).toEqual(blob);
    expect(back.sources).toEqual(sources);

    // An array blob becomes the same one envelope object and reads back as the array.
    const listRow = await db.insert(leafTable, { scope: OWNER, kind: null, blob: ['a', { b: 1 }] });
    expect(Object.keys(await rawJson(listRow.id, 'blob'))).toEqual([ENC]);
    expect((await db.get(leafTable, { id: listRow.id })).blob).toEqual(['a', { b: 1 }]);
  });

  test('E1′ mixed rows: a plaintext pre-encryption row reads through; the encrypt walk converges it per leaf; an unknown kind still decrypts; re-runs rewrite nothing', async () => {
    await seedPlaintextRow('leaf-legacy-1', 'trip', { content: 'legacy words', type: 'h1', state: 'planned' });
    await seedPlaintextRow('leaf-legacy-2', 'note', { content: 'other legacy words', type: 'body1' });
    const live = await db.insert(leafTable, { scope: OWNER, kind: 'note', doc: { content: 'live', type: 'body1' } });

    // Pass-through: the pre-encryption bytes read exactly.
    expect((await db.get(leafTable, { id: 'leaf-legacy-1' })).doc).toEqual({
      content: 'legacy words',
      type: 'h1',
      state: 'planned',
    });

    const summary = await walker.walkTable(leafTable, 'encrypt', { dbDriver: spannerDriver, db: systemDb });
    expect(summary.scanned).toBe(3);
    expect(summary.rewritten).toBe(2); // the two legacy rows; the live row already converged

    const legacy1 = await rawJson('leaf-legacy-1', 'doc');
    expect(envelope.isEnvelope(legacy1.content)).toBe(true);
    expect(legacy1.state).toBe('planned'); // a trip fact, plaintext under its policy
    expect(legacy1.type).toBe('h1');
    const legacy2 = await rawJson('leaf-legacy-2', 'doc');
    expect(envelope.isEnvelope(legacy2.content)).toBe(true);
    expect(legacy2.type).toBe('body1');
    expect((await db.get(leafTable, { id: 'leaf-legacy-1' })).doc.content).toBe('legacy words');

    // A row whose kind no longer resolves any policy still decrypts (reads need no policy).
    await spannerDriver.runDml(() => ({
      sql: `UPDATE \`${leafTable.name}\` SET \`kind\` = 'deleted-kind' WHERE \`id\` = 'leaf-legacy-1'`,
    }));
    expect((await db.get(leafTable, { id: 'leaf-legacy-1' })).doc).toEqual({
      content: 'legacy words',
      type: 'h1',
      state: 'planned',
    });

    // IDEMPOTENCE + a policy change converges in the encrypt walk: under `deleted-kind` the
    // default policy calls `state` content, so exactly that row is pending again — once.
    const rerun = await walker.walkTable(leafTable, 'encrypt', { dbDriver: spannerDriver, db: systemDb });
    expect(rerun.rewritten).toBe(1);
    expect(envelope.isEnvelope((await rawJson('leaf-legacy-1', 'doc')).state)).toBe(true);
    const again = await walker.walkTable(leafTable, 'encrypt', { dbDriver: spannerDriver, db: systemDb });
    expect(again.rewritten).toBe(0);
    void live;
  });

  test('E1′ read-modify-write: a save landing between the walker’s read and write survives — the newer body is what the seam reads', async () => {
    await seedPlaintextRow('leaf-race-1', 'note', { content: 'the old body', type: 'body1' });
    let interposed = 0;
    let interposedWrite: Promise<unknown> | undefined;
    (walker as unknown as WalkerInternals).interposeBeforeRewrite = async (id) => {
      if (id !== 'leaf-race-1' || interposed++ > 0) {
        return;
      }
      // An old pod's save (raw plaintext DML on its own connection) while the walker's transaction is open.
      interposedWrite = new SpannerDriver({
        projectId: 'proteinjs-test',
        instanceName: 'proteinjs-test',
        databaseName: 'test',
      })
        .runDml(() => ({
          sql: `UPDATE \`${leafTable.name}\` SET \`doc\` = JSON '{"content":"the newer body","type":"body1"}' WHERE \`id\` = 'leaf-race-1'`,
        }))
        .catch(() => undefined);
      // The emulator may hold a concurrent read-write transaction until ours ends (real Spanner
      // lets it commit and aborts ours); either way the assertion below must hold.
      await Promise.race([interposedWrite, new Promise((resolve) => setTimeout(resolve, 3000))]);
    };

    await walker.walkTable(leafTable, 'encrypt', { dbDriver: spannerDriver, db: systemDb });
    // The deferred interposed write lands once the walker's transaction ended — wait for it, never strand it.
    await interposedWrite;

    expect((await db.get(leafTable, { id: 'leaf-race-1' })).doc.content).toBe('the newer body');
    // Converged by this or the next walk — never lost.
    await walker.walkTable(leafTable, 'encrypt', { dbDriver: spannerDriver, db: systemDb });
    const stored = await rawJson('leaf-race-1', 'doc');
    expect(envelope.isEnvelope(stored.content)).toBe(true);
    expect((await db.get(leafTable, { id: 'leaf-race-1' })).doc.content).toBe('the newer body');
  });

  test('M4 decrypt-out rollback on the LIVE declaration: the walk writes plaintext JSON that is canonical-equal to the original, per leaf, and re-runs rewrite nothing', async () => {
    const doc = { content: 'roll me back', type: 'h1', state: 'planned', nested: { note: 'n', k: 1 } };
    const sources = [{ id: 's1', url: 'https://a.test', title: 'A' }];
    const blob = { why: 'because', n: 2 };
    const row = await db.insert(leafTable, { scope: OWNER, kind: 'trip', doc, sources, blob });
    expect(envelope.isEnvelope((await rawJson(row.id, 'doc')).content)).toBe(true);

    const summary = await walker.walkTable(leafTable, 'decrypt', {
      columns: ['doc', 'sources', 'blob'],
      dbDriver: spannerDriver,
      db: systemDb,
    });
    expect(summary.rewritten).toBe(1);

    expect(await rawJson(row.id, 'doc')).toEqual(doc);
    expect(await rawJson(row.id, 'sources')).toEqual({ [ARR]: sources });
    expect(await rawJson(row.id, 'blob')).toEqual(blob);
    expect(new LeafEnvelopeCodec().containsEnvelope(await rawJson(row.id, 'doc'))).toBe(false);
    expect((await db.get(leafTable, { id: row.id })).doc).toEqual(doc);

    const rerun = await walker.walkTable(leafTable, 'decrypt', {
      columns: ['doc', 'sources', 'blob'],
      dbDriver: spannerDriver,
      db: systemDb,
    });
    expect(rerun.rewritten).toBe(0);

    // The declaration is still on: the next ordinary write encrypts again (the walk did not
    // change the contract, only the stored bytes — rolling the image back is the second act).
    await db.update(leafTable, { id: row.id, doc: { ...doc, content: 'written after the walk' } });
    expect(envelope.isEnvelope((await rawJson(row.id, 'doc')).content)).toBe(true);
  });

  test('rotate-keys walks every leaf envelope of a document to the new version', async () => {
    const row = await db.insert(leafTable, {
      scope: OWNER,
      kind: null,
      doc: { content: 'a', nested: { note: 'b' }, type: 'h1' },
      sources: [{ id: 's1', url: 'u' }],
    });
    const before = await rawJson(row.id, 'doc');
    expect(envelope.parse(before.content)?.version).toBe(1);

    const newVersion = await new DataKeyStore().rotateKey(OWNER);
    const summary = await walker.walkTable(leafTable, 'rotate-keys', { dbDriver: spannerDriver, db: systemDb });
    expect(summary.rewritten).toBe(1);

    const after = await rawJson(row.id, 'doc');
    expect(envelope.parse(after.content)?.version).toBe(newVersion);
    expect(envelope.parse(after.nested.note)?.version).toBe(newVersion);
    expect(envelope.parse((await rawJson(row.id, 'sources'))[ARR][0][ENC])?.version).toBe(newVersion);
    expect((await db.get(leafTable, { id: row.id })).doc.content).toBe('a');
    expect((await walker.walkTable(leafTable, 'rotate-keys', { dbDriver: spannerDriver, db: systemDb })).rewritten).toBe(0);
  });

  test('updatePreserving commutes through the seam: the preserved content path survives with a fresh envelope', async () => {
    const row = await db.insert(leafTable, { scope: OWNER, kind: null, doc: { content: 'keep me', type: 'h1', fontSize: 12 } });
    const before = await rawJson(row.id, 'doc');

    await db.updatePreserving(leafTable, { id: row.id, doc: { content: 'stale editor copy', type: 'h1', fontSize: 18 } }, [
      { columnPropertyName: 'doc', paths: ['content'] },
    ]);

    const after = await rawJson(row.id, 'doc');
    expect(after.fontSize).toBe(18);
    expect(after.content).not.toBe(before.content); // re-encrypted with a fresh IV
    expect((await db.get(leafTable, { id: row.id })).doc).toEqual({ content: 'keep me', type: 'h1', fontSize: 18 });
  });

  test('LeafPaths.assertMetadata gates raw SQL: a platform path passes, a content path throws, a whole-value column throws', () => {
    expect(() => LeafPaths.assertMetadata(leafTable, 'doc', '$.type')).not.toThrow();
    expect(() => LeafPaths.assertMetadata(leafTable, 'doc', '$.content')).toThrow(/not declared metadata/);
    expect(() => LeafPaths.assertMetadata(leafTable, 'doc', '$.state')).toThrow(/not declared metadata/); // metadata for trips only
    expect(() => LeafPaths.assertMetadata(leafTable, 'blob', '$.n')).toThrow(/not declared metadata/);
    expect(() => LeafPaths.assertMetadata(leafTable, 'kind', '$')).not.toThrow(); // plaintext column: nothing to assert
    expect(new EncryptedColumns().leafProps(leafTable).sort()).toEqual(['blob', 'doc', 'sources']);
  });
});
