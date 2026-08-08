import moment from 'moment';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { Db, DateColumn, QueryBuilderFactory, Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * Proves the generic record-table query path over the session table shape.
 *
 * The admin Sessions record table (settings menu → Sessions) runs EXACTLY this query through
 * DbService: rows written by DbSessionStore (system db, Table layer), read back with the
 * QueryTableLoader query — sort `updated desc`, paginate. When it showed zero rows on a server
 * with live sessions (2026-08), the suspects were the query shape itself: a physical table the
 * Table def can't read, scope filtering dropping every row, or a default sort on an unpopulated
 * column. This test pins the query shape against real Spanner semantics: store-shaped rows come
 * back, all of them, newest-first — so an empty result at that surface means the query never ran
 * (it was denied; the UI rendered the failure as "no rows"), not that the data is unreadable.
 */

interface SessionShape extends Record {
  sessionId: string;
  session: string;
  expires: Date;
  userEmail: string;
}

/** Mirrors @proteinjs/user SessionTable column-for-column (namespaced test table name). */
class SessionShapeTable extends Table<SessionShape> {
  name = 'db_test_session_record_table_query';
  columns = withRecordColumns<SessionShape>({
    sessionId: new StringColumn('session_id'),
    session: new StringColumn('serialized_session', {}, 4000),
    expires: new DateColumn('expires'),
    userEmail: new StringColumn('user_email'),
  });
}

const table = new SessionShapeTable();
const getTable = (tableName: string) => {
  if (tableName === table.name) {
    return table;
  }
  throw new Error(`Unexpected table lookup in test: ${tableName}`);
};

const spannerDriver = new SpannerDriver(
  {
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  },
  getTable
);

/**
 * What DbSessionStore serializes into a row (shape from a real dev session). `updated` is
 * stamped explicitly for deterministic newest-first assertions: the insert-time default takes
 * moment() per row, and rows landing in the same millisecond would make the order ambiguous.
 */
const storeShapedRow = (n: number, updatedMs: number) => ({
  sessionId: `test-session-${n}`,
  session: JSON.stringify({
    cookie: { originalMaxAge: 5184000000, expires: '2026-10-01T00:00:00.000Z', httpOnly: true, path: '/' },
    passport: { user: `user-${n}@test.local` },
  }),
  expires: new Date(Date.now() + 5184000000),
  userEmail: `user-${n}@test.local`,
  updated: moment(updatedMs),
});

describe('Session-shaped record table query (the admin Sessions table path)', () => {
  const dropTable = getDropTestTable(spannerDriver);
  // Writes as the session store writes (system db), reads as the record table reads.
  const systemDb = new Db(spannerDriver, getTable, new TransactionContext(), true);
  const db = new Db(spannerDriver, getTable, new TransactionContext());

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    await dropTable(table);
    await spannerDriver.getTableManager().loadTable(table);
  }, 60000);

  afterAll(async () => {
    await dropTable(table);
    await SpannerEmulatorProvisioner.release();
  }, 30000);

  test('store-written session rows all come back through the record-table query, newest-first', async () => {
    // Insert like DbSessionStore.insertOrUpdate: system db, store-shaped fields, staggered updates.
    const base = Date.now() - 60_000;
    for (let n = 1; n <= 3; n++) {
      await systemDb.insert(table, storeShapedRow(n, base + n * 1000) as any);
    }

    // EXACTLY QueryTableLoader.load's query: sort updated desc, paginate the first window.
    const qb = new QueryBuilderFactory()
      .createQueryBuilder<SessionShape>(table)
      .sort([{ field: 'updated', desc: true }])
      .paginate({ start: 0, end: 10 });
    const rows = await db.query(table, qb);

    expect(rows.map((row) => row.sessionId)).toEqual(['test-session-3', 'test-session-2', 'test-session-1']);
    // Round-trip fidelity of the store-shaped fields the table displays.
    expect(rows[0].userEmail).toBe('user-3@test.local');
    expect(JSON.parse(rows[0].session).passport.user).toBe('user-3@test.local');
    expect(rows[0].expires).toBeTruthy();

    // The pagination variant of the loader also asks for the row count.
    const countQb = new QueryBuilderFactory().createQueryBuilder<SessionShape>(table);
    expect(await db.getRowCount(table, countQb)).toBe(3);
  }, 60000);
});
