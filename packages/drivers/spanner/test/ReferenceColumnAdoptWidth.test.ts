import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { Db, Record, Reference, ReferenceColumn, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import {
  AdoptWidthRecord,
  ADOPT_WIDTH_TABLE_NAME,
  ADOPT_WIDTH_TARGET_TABLE_NAME,
  ReferenceAdoptWidthTestTable,
} from './util/referenceAdoptWidthTestTables';
import '../generated/test/index';

/**
 * `ReferenceColumn`'s width-adoption option (`maxLength`), which exists so an EXISTING string-uuid
 * column can be retyped to a reference IN PLACE — same storage type, same bytes, zero DDL.
 *
 * The default reference width is STRING(36), but a column that predates the reference type was
 * created at StringColumn's default STRING(255); Spanner cannot narrow a STRING in place, so
 * without adopting the existing width the schema sync doesn't just emit DDL — it throws and
 * bricks boot. Contracts, as outcomes against the live emulator schema:
 *  1. Adopting the existing width means the sync sees NO changes for the retype (no DDL at all).
 *  2. Storage is byte-identical both directions: rows written by the string era read back as
 *     references to the same id, and reference writes store the raw id string.
 *  3. The stock (36) shape against a 255-width column is a narrowing: reported as a type change
 *     and refused by the alter pass — the documented reason the adoption option must be passed.
 */

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

const TABLE_NAME = ADOPT_WIDTH_TABLE_NAME;
const TARGET_TABLE_NAME = ADOPT_WIDTH_TARGET_TABLE_NAME;

interface LegacyRecord extends Record {
  invitedBy?: string | null;
}

/** The string era: how the column was originally declared (and lives in deployed schemas). */
const legacyTable = (): Table<LegacyRecord> => {
  return new (class extends Table<LegacyRecord> {
    name = TABLE_NAME;
    columns = withRecordColumns<LegacyRecord>({
      invitedBy: new StringColumn('invited_by'),
    });
  })();
};

/** The retype under test: same physical column, adopted at its existing width (registered — Db
 *  statement generation resolves tables by name through the reflection registry). */
const adoptedTable = (): Table<AdoptWidthRecord> => new ReferenceAdoptWidthTestTable();

/** The stock shape (36): what the retype would be WITHOUT width adoption. */
const stockWidthTable = (): Table<AdoptWidthRecord> => {
  return new (class extends Table<AdoptWidthRecord> {
    name = TABLE_NAME;
    columns = withRecordColumns<AdoptWidthRecord>({
      invitedBy: new ReferenceColumn<Record>('invited_by', TARGET_TABLE_NAME, false),
    });
  })();
};

type TableManagerInternals = {
  getTableChanges(table: Table<any>): Promise<{
    columnsToCreate: string[];
    columnsToAlter: string[];
    columnTypeChanges: { name: string; newType: string; oldType: string }[];
  }>;
  shouldAlterTable(tableChanges: unknown): boolean;
};

describe('ReferenceColumn width adoption (string uuid column retyped in place)', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const tableManager = spannerDriver.getTableManager();
  const tableManagerInternals = tableManager as unknown as TableManagerInternals;

  const STRING_ERA_UUID = '3f2a9c04-6b1d-4e8a-9c37-5d20f4a81b6e';
  const REFERENCE_ERA_UUID = '9b7c1e52-0d4f-4a63-8e91-2c85d6f03a47';

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    await dropTable(legacyTable());
  }, 30000);

  afterAll(async () => {
    await dropTable(legacyTable());
    await SpannerEmulatorProvisioner.release();
  }, 30000);

  test('retype with the adopted width is invisible to the schema sync — zero DDL', async () => {
    // The string era: the column exists as STRING(255) and holds a raw uuid.
    const legacy = legacyTable();
    await tableManager.loadTable(legacy);
    expect((await tableManager.schemaMetadata.getColumnMetadata(legacy))['invited_by'].type).toBe('STRING(255)');
    await spannerDriver.runDml(() => ({
      sql: `INSERT INTO ${TABLE_NAME} (id, invited_by) VALUES (@id, @invitedBy)`,
      namedParams: {
        params: { id: 'string-era-row', invitedBy: STRING_ERA_UUID },
        types: { id: 'string', invitedBy: 'string' },
      },
    }));

    // The retype: the sync must see NOTHING to do.
    const adopted = adoptedTable();
    const tableChanges = await tableManagerInternals.getTableChanges(adopted);
    expect(tableChanges.columnTypeChanges).toEqual([]);
    expect(tableChanges.columnsToAlter).toEqual([]);
    expect(tableChanges.columnsToCreate).toEqual([]);
    expect(tableManagerInternals.shouldAlterTable(tableChanges)).toBe(false);

    // And a full load pass leaves the live column untouched.
    await tableManager.loadTable(adopted);
    expect((await tableManager.schemaMetadata.getColumnMetadata(adopted))['invited_by'].type).toBe('STRING(255)');
  }, 60000);

  test('storage stays byte-identical: string-era rows read as references; reference writes store the raw id', async () => {
    const adopted = adoptedTable();
    // As-system, like the server-side writers of adopted columns (TableAuth is not under test).
    const db = new Db(spannerDriver, () => adopted, new TransactionContext(), true);

    // The row written by the string era reads back through the retyped column as a reference
    // to the exact same id.
    const stringEraRow = await db.get(adopted, { id: 'string-era-row' });
    expect(stringEraRow.invitedBy).toBeInstanceOf(Reference);
    expect(stringEraRow.invitedBy?._id).toBe(STRING_ERA_UUID);
    expect(stringEraRow.invitedBy?._table).toBe(TARGET_TABLE_NAME);

    // A reference written through the retyped column stores the raw id string — the same bytes
    // the string era would have written.
    const inserted = await db.insert(adopted, {
      invitedBy: new Reference<Record>(TARGET_TABLE_NAME, REFERENCE_ERA_UUID),
    });
    const rows = await spannerDriver.runQuery(() => ({
      sql: `SELECT invited_by FROM ${TABLE_NAME} WHERE id = @id`,
      namedParams: { params: { id: inserted.id }, types: { id: 'string' } },
    }));
    expect(rows[0].invited_by).toBe(REFERENCE_ERA_UUID);
  }, 60000);

  test('the stock 36 width against a 255 column is a narrowing: reported as a type change and refused', async () => {
    const stock = stockWidthTable();
    const tableChanges = await tableManagerInternals.getTableChanges(stock);
    expect(tableChanges.columnTypeChanges).toEqual([
      { name: 'invited_by', oldType: 'STRING(255)', newType: 'STRING(36)' },
    ]);
    await expect(tableManager.loadTable(stock)).rejects.toThrow(/Unable to change column types in Spanner/);
  }, 60000);
});
