import { Column, IntegerColumn, Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * The schema only moves forward. A build whose declaration asks for LESS than the live column
 * already gives — an older build serving after a rollback, before the next release re-runs its
 * migrations — must boot and serve: the sync never narrows a column, never tightens or relaxes
 * its nullability, and never fails on a live schema that is a superset of what it declares. It
 * names each such difference once per sync (info; warn where a later write could fail) and
 * continues, issuing no DDL for it.
 *
 * What the sync still does: widen a column the declaration asks wider (the one in-place type
 * change Spanner supports) — restating the LIVE nullability, never the declared one — and refuse
 * a different base type with the same words as before.
 */

const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};

const spannerDriver = new SpannerDriver(spannerConfig);
const TABLE_NAME = 'db_test_schema_forward';

interface ForwardRecord extends Record {
  note?: string | number;
}

/** The same table under different declarations of its one `note` column. */
const tableWhere = (note: Column<any, any>): Table<ForwardRecord> =>
  new (class extends Table<ForwardRecord> {
    name = TABLE_NAME;
    columns = withRecordColumns<ForwardRecord>({ note });
  })();

type Line = { message?: string };
type SpannerTableManager = ReturnType<SpannerDriver['getTableManager']>;

/** The instance's own logger (a typed cast, house style): the lines the sync writes about a table. */
const loggerOf = (tableManager: SpannerTableManager) =>
  (tableManager as unknown as { logger: { info(line: Line): void; warn(line: Line): void } }).logger;

const leftAsItStands = (calls: Line[][]) =>
  calls.map(([line]) => line.message ?? '').filter((message) => /left as it stands/.test(message));

describe('the schema only moves forward', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const tableManager = spannerDriver.getTableManager();

  const insert = (id: string, note: string | null) =>
    spannerDriver.runDml(() => ({
      sql: `INSERT INTO ${TABLE_NAME} (id, note) VALUES (@id, @note)`,
      namedParams: { params: { id, note }, types: { id: 'string', note: 'string' } },
    }));

  const noteOf = async (id: string) => {
    const rows = await spannerDriver.runQuery(() => ({
      sql: `SELECT note FROM ${TABLE_NAME} WHERE id = @id`,
      namedParams: { params: { id }, types: { id: 'string' } },
    }));
    return rows[0].note;
  };

  const noteColumn = async (table: Table<ForwardRecord>) =>
    (await tableManager.schemaMetadata.getColumnMetadata(table))['note'];

  /** Sync `table` with the sync's lines and its DDL captured. */
  const sync = async (table: Table<ForwardRecord>) => {
    const logger = loggerOf(tableManager);
    const info = jest.spyOn(logger, 'info');
    const warn = jest.spyOn(logger, 'warn');
    const ddl = jest.spyOn(spannerDriver, 'runUpdateSchema');
    try {
      const outcome = await tableManager.loadTable(table).then(
        () => undefined,
        (error: unknown) => error
      );
      return {
        thrown: outcome,
        info: leftAsItStands(info.mock.calls),
        warn: leftAsItStands(warn.mock.calls),
        ddl: ddl.mock.calls.length,
      };
    } finally {
      info.mockRestore();
      warn.mockRestore();
      ddl.mockRestore();
    }
  };

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
  }, 60000);

  beforeEach(async () => {
    await dropTable(tableWhere(new StringColumn('note')));
  }, 60000);

  afterAll(async () => {
    await dropTable(tableWhere(new StringColumn('note')));
    SpannerEmulatorProvisioner.release();
  }, 60000);

  test('a live STRING(MAX) where STRING(500) is declared stands: the sync completes, no DDL, one info line', async () => {
    await tableManager.loadTable(tableWhere(new StringColumn('note', undefined, 'MAX')));
    const long = 'x'.repeat(3000);
    await insert('wide-row', long);

    const synced = await sync(tableWhere(new StringColumn('note', undefined, 500)));

    expect(synced.thrown).toBeUndefined();
    expect(synced.ddl).toBe(0);
    expect((await noteColumn(tableWhere(new StringColumn('note')))).type).toBe('STRING(MAX)');
    expect(await noteOf('wide-row')).toBe(long);
    expect(synced.info).toEqual([expect.stringContaining(`[${TABLE_NAME}.note]`)]);
    expect(synced.info[0]).toContain('STRING(MAX)');
    expect(synced.info[0]).toContain('STRING(500)');
    expect(synced.warn).toEqual([]);
  }, 60000);

  test('a live NULLABLE column where NOT NULL is declared stands: the sync completes, no DDL, one info line', async () => {
    await tableManager.loadTable(tableWhere(new StringColumn('note')));
    await insert('null-row', null);

    const synced = await sync(tableWhere(new StringColumn('note', { nullable: false })));

    expect(synced.thrown).toBeUndefined();
    expect(synced.ddl).toBe(0);
    expect((await noteColumn(tableWhere(new StringColumn('note')))).isNullable).toBe(true);
    expect(await noteOf('null-row')).toBeNull();
    expect(synced.info).toEqual([
      expect.stringContaining(`[${TABLE_NAME}.note] Live column is NULLABLE where NOT NULL is declared`),
    ]);
    expect(synced.warn).toEqual([]);
  }, 60000);

  test('a live STRING(200) where STRING(500) is declared is widened in place, as before', async () => {
    await tableManager.loadTable(tableWhere(new StringColumn('note', undefined, 200)));

    const synced = await sync(tableWhere(new StringColumn('note', undefined, 500)));

    expect(synced.thrown).toBeUndefined();
    expect(synced.ddl).toBe(1);
    expect((await noteColumn(tableWhere(new StringColumn('note')))).type).toBe('STRING(500)');
    expect(synced.info).toEqual([]);
    expect(synced.warn).toEqual([]);
  }, 60000);

  test('a widening restates the LIVE nullability: a nullable STRING(200) declared NOT NULL STRING(500) widens and stays nullable', async () => {
    await tableManager.loadTable(tableWhere(new StringColumn('note', undefined, 200)));
    await insert('null-row', null);

    const synced = await sync(tableWhere(new StringColumn('note', { nullable: false }, 500)));

    expect(synced.thrown).toBeUndefined();
    const live = await noteColumn(tableWhere(new StringColumn('note')));
    expect(live.type).toBe('STRING(500)');
    expect(live.isNullable).toBe(true);
    expect(await noteOf('null-row')).toBeNull();
    expect(synced.info).toEqual([
      expect.stringContaining(`[${TABLE_NAME}.note] Live column is NULLABLE where NOT NULL is declared`),
    ]);
  }, 60000);

  test('a different base type is still refused, with the same words', async () => {
    await tableManager.loadTable(tableWhere(new StringColumn('note', undefined, 'MAX')));

    const synced = await sync(tableWhere(new IntegerColumn('note')));

    expect(synced.thrown).toBeInstanceOf(Error);
    expect((synced.thrown as Error).message).toMatch(/Unable to change column types in Spanner/);
    expect((synced.thrown as Error).message).toContain('from: STRING(MAX) to: INT64');
    expect(synced.ddl).toBe(0);
    expect((await noteColumn(tableWhere(new StringColumn('note')))).type).toBe('STRING(MAX)');
    expect(synced.info).toEqual([]);
  }, 60000);

  test('a live NOT NULL column where NULLABLE is declared stands: the sync completes, no DDL, one warn line', async () => {
    await tableManager.loadTable(tableWhere(new StringColumn('note', { nullable: false })));
    await insert('kept-row', 'kept');

    const synced = await sync(tableWhere(new StringColumn('note', { nullable: true })));

    expect(synced.thrown).toBeUndefined();
    expect(synced.ddl).toBe(0);
    expect((await noteColumn(tableWhere(new StringColumn('note')))).isNullable).toBe(false);
    expect(await noteOf('kept-row')).toBe('kept');
    expect(synced.warn).toEqual([
      expect.stringContaining(`[${TABLE_NAME}.note] Live column is NOT NULL where NULLABLE is declared`),
    ]);
    expect(synced.info).toEqual([]);
  }, 60000);
});
