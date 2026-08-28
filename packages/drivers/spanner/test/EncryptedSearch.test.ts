import {
  Db,
  Table,
  setDbEncryptionConfig,
  InMemoryMasterKeyProvider,
  EncryptedColumns,
  QueryBuilder,
} from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import { EncSearchDoc, EncSearchDocTable } from './util/columnEncryptionTestTables';
import { loadColumnEncryptionTestSchema, purgeColumnEncryptionTestRows } from './util/columnEncryptionTestHarness';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import '../generated/test/index';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

(globalThis as any)['__proteinjs_db_defaultDbDriver'] = spannerDriver;

const OWNER_A = 'enc-search-owner-a';
const OWNER_B = 'enc-search-owner-b';

let accessibleOwners: string[] = [OWNER_A];

const docTable = new EncSearchDocTable() as Table<EncSearchDoc>;
const db = new Db(spannerDriver, undefined, new TransactionContext());

const titleLike = (pattern: string) =>
  new QueryBuilder<EncSearchDoc>(docTable.name).condition({ field: 'title', operator: 'LIKE', value: pattern });

const titlesOf = (rows: EncSearchDoc[]) => rows.map((row) => row.title).sort();

/**
 * Search exactness over encrypted columns — the recheck contract: the token index answers a
 * candidate set, each candidate is verified against the decrypted value, so NO false
 * positive surfaces and NO true match is missed (query words >= 3 chars); 1-2 character
 * query words behave as word-prefix search (the documented narrowing).
 */
describe('Encrypted search: exact contains/prefix, equality, shared-scope OR', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const tableManager = spannerDriver.getTableManager();
  const seeded: string[] = [];

  const seed = async (scope: string, title: string | null, name?: string | null, kind?: string) => {
    const row = await db.insert(docTable, { scope, title, name: name ?? null, kind: kind ?? 'doc' });
    seeded.push(row.id);
    return row;
  };

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    registerTestUser();
    setDbEncryptionConfig({
      masterKeyProvider: new InMemoryMasterKeyProvider('column-encryption-test'),
      getAccessibleKeyOwners: async () => accessibleOwners,
    });
    await loadColumnEncryptionTestSchema(tableManager, [docTable]);
    await purgeColumnEncryptionTestRows(spannerDriver, [docTable]);

    // The corpus: owner A's documents...
    await seed(OWNER_A, 'Groceries list');
    await seed(OWNER_A, 'Grocery budget planning');
    await seed(OWNER_A, 'Pancake factory notes');
    await seed(OWNER_A, 'cake factory shift plan');
    await seed(OWNER_A, 'Therapy notes — divorce');
    await seed(OWNER_A, 'n3xa notes');
    await seed(OWNER_A, null, 'tag-null-title');
    await seed(OWNER_A, 'Once and future factories');
    // holds every fragment of "cake factory" NON-contiguously — a token-cover candidate the
    // verify step must reject
    await seed(OWNER_A, 'factory made cake platter');
    // ...and owner B's (a sharer), including an overlapping word
    await seed(OWNER_B, 'Groceries for the trip');
    await seed(OWNER_B, 'B-only cake recipe');
  }, 120000);

  afterAll(async () => {
    for (const id of seeded) {
      await db.delete(docTable, { id }).catch(() => undefined);
    }
    setDbEncryptionConfig(undefined);
    clearTestUser();
    await dropTable(new EncryptedColumns().tokenTableFor(docTable)!);
    await dropTable(docTable);
    await SpannerEmulatorProvisioner.release();
  }, 120000);

  beforeEach(() => {
    accessibleOwners = [OWNER_A];
  });

  test('contains search is exact: every true match returned, nothing else (the home-search shape)', async () => {
    const rows = await db.query(docTable, titleLike('%Groceries%'));
    expect(titlesOf(rows)).toEqual(['Groceries list']);

    // multi-word contains, matching across a word prefix ("cake factory" inside "Pancake
    // factory") — and NOT matching 'factory made cake platter', whose token cover holds
    // every fragment non-contiguously (the verify step rejects it)
    const factoryRows = await db.query(docTable, titleLike('%cake factory%'));
    expect(titlesOf(factoryRows)).toEqual(['Pancake factory notes', 'cake factory shift plan']);
  });

  test('no false positives: rows holding all fragments non-contiguously are rejected by the verify step', async () => {
    // "Once and future factories" holds trigrams of 'fact'/'tor' etc. — but not the
    // contiguous phrase "factory shift"
    const rows = await db.query(docTable, titleLike('%factory shift%'));
    expect(titlesOf(rows)).toEqual(['cake factory shift plan']);
  });

  test('case-insensitive LIKE (caseSensitive=false) matches across case', async () => {
    const qb = new QueryBuilder<EncSearchDoc>(docTable.name);
    qb.condition({ field: 'title', operator: 'LIKE', value: '%GROCERIES%' }, undefined, false);
    const rows = await db.query(docTable, qb);
    expect(titlesOf(rows)).toEqual(['Groceries list']);

    // and the default case-sensitive LIKE stays exact about case
    const strict = await db.query(docTable, titleLike('%GROCERIES%'));
    expect(strict.length).toBe(0);
  });

  test('prefix search (q%) matches value starts only', async () => {
    const rows = await db.query(docTable, titleLike('Groc%'));
    expect(titlesOf(rows)).toEqual(['Groceries list', 'Grocery budget planning']);
  });

  test('1-2 character queries behave as word-prefix search (the documented narrowing)', async () => {
    // 'n' finds "n3xa notes" (word start), and also "notes" words — anything with an n-starting word
    const rows = await db.query(docTable, titleLike('%n%'));
    for (const row of rows) {
      expect(
        (row.title ?? '')
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .some((word) => word.startsWith('n'))
      ).toBe(true);
    }
    expect(titlesOf(rows)).toContain('n3xa notes');

    // a 1-2 char MID-WORD substring is documented unsupported: 'x' inside 'n3xa' does not match
    const midWord = await db.query(docTable, titleLike('%x%'));
    expect(titlesOf(midWord)).toEqual([]);
  });

  test('composition: encrypted search ANDs with metadata conditions natively', async () => {
    const rows = await db.query(
      docTable,
      titleLike('%Groceries%').condition({ field: 'kind', operator: '=', value: 'doc' })
    );
    expect(titlesOf(rows)).toEqual(['Groceries list']);

    const noRows = await db.query(
      docTable,
      titleLike('%Groceries%').condition({ field: 'kind', operator: '=', value: 'other' })
    );
    expect(noRows.length).toBe(0);
  });

  test('getRowCount over an encrypted search is exact', async () => {
    expect(await db.getRowCount(docTable, titleLike('%cake factory%'))).toBe(2);
  });

  test('equality lookup rides the whole-value fingerprint: exact, case-exact (the tag get-or-create shape)', async () => {
    await seed(OWNER_A, 'eq holder', 'Divorce');
    await seed(OWNER_A, 'eq holder 2', 'divorce');

    const exact = await db.get(docTable, { name: 'Divorce' });
    expect(exact.title).toBe('eq holder');

    const lower = await db.query(docTable, { name: 'divorce' } as any);
    expect(lower.length).toBe(1);
    expect(lower[0].title).toBe('eq holder 2');

    const missing = await db.get(docTable, { name: 'no-such-tag' });
    expect(missing).toBeFalsy();
  });

  test('shared-scope search: fingerprints once per accessible owner, ORs the matches', async () => {
    // Only own scope accessible: A sees only A's groceries
    const own = await db.query(docTable, titleLike('%Groceries%'));
    expect(titlesOf(own)).toEqual(['Groceries list']);

    // B shares with A: the same caller query now covers both owners' keys
    accessibleOwners = [OWNER_A, OWNER_B];
    const shared = await db.query(docTable, titleLike('%Groceries%'));
    expect(titlesOf(shared)).toEqual(['Groceries for the trip', 'Groceries list']);
  });

  test('token rows follow the row lifecycle: update rewrites them, delete removes them', async () => {
    const row = await db.insert(docTable, {
      scope: OWNER_A,
      title: 'ephemeral zebra thoughts',
      name: null,
      kind: 'doc',
    });

    expect(titlesOf(await db.query(docTable, titleLike('%zebra%')))).toEqual(['ephemeral zebra thoughts']);

    await db.update(docTable, { id: row.id, title: 'renamed giraffe thoughts' });
    expect((await db.query(docTable, titleLike('%zebra%'))).length).toBe(0);
    expect(titlesOf(await db.query(docTable, titleLike('%giraffe%')))).toEqual(['renamed giraffe thoughts']);

    await db.delete(docTable, { id: row.id });
    expect((await db.query(docTable, titleLike('%giraffe%'))).length).toBe(0);

    // and the token table holds no orphans for the deleted row
    const tokenTable = new EncryptedColumns().tokenTableFor(docTable)!;
    const orphans = await spannerDriver.runQuery(() => ({
      sql: `SELECT COUNT(*) as tokenCount FROM \`${tokenTable.name}\` WHERE \`record_id\` = '${row.id}'`,
    }));
    expect(Number((orphans[0] as any).tokenCount)).toBe(0);
  });

  test('delete by encrypted search: WHERE title LIKE deletes exactly the true matches', async () => {
    const kept = await db.insert(docTable, { scope: OWNER_A, title: 'wombat keep', name: null, kind: 'doc' });
    const doomed = await db.insert(docTable, { scope: OWNER_A, title: 'wombat purge now', name: null, kind: 'doc' });

    const deleteCount = await db.delete(docTable, titleLike('%purge now%'));
    expect(deleteCount).toBe(1);
    expect((await db.get(docTable, { id: kept.id })).title).toBe('wombat keep');
    expect(await db.get(docTable, { id: doomed.id })).toBeFalsy();

    await db.delete(docTable, { id: kept.id });
  });

  test('update by encrypted search: WHERE title LIKE updates exactly the true matches', async () => {
    const target = await db.insert(docTable, { scope: OWNER_A, title: 'quokka target row', name: null, kind: 'doc' });
    const bystander = await db.insert(docTable, { scope: OWNER_A, title: 'quokka bystander', name: null, kind: 'doc' });

    const updateCount = await db.update(docTable, { kind: 'flagged' }, titleLike('%target row%'));
    expect(updateCount).toBe(1);
    expect((await db.get(docTable, { id: target.id })).kind).toBe('flagged');
    expect((await db.get(docTable, { id: bystander.id })).kind).toBe('doc');

    await db.delete(docTable, { id: target.id });
    await db.delete(docTable, { id: bystander.id });
  });
});
