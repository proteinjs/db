import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { StringColumn, Table, withRecordColumns, Record } from '@proteinjs/db';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

interface WideningRecord extends Record {
  title?: string;
  label?: string;
}

/** Same table declared twice — narrow (creation-time) and widened (the schema change under test). */
const wideningTable = (titleLength: number | 'MAX'): Table<WideningRecord> => {
  return new (class extends Table<WideningRecord> {
    name = 'db_test_string_widening';
    columns = withRecordColumns<WideningRecord>({
      title: new StringColumn('title', undefined, titleLength),
      label: new StringColumn('label', { nullable: false }),
    });
  })();
};

describe('Spanner STRING widening', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const tableManager = spannerDriver.getTableManager();

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    await dropTable(wideningTable(255));
  }, 30000);

  afterAll(async () => {
    await dropTable(wideningTable(255));
    await SpannerEmulatorProvisioner.release();
  }, 30000);

  test('widens STRING(255) to STRING(MAX) in place, preserving rows and nullability', async () => {
    const narrow = wideningTable(255);
    await tableManager.loadTable(narrow);
    const id = 'widening-test-row';
    await spannerDriver.runDml(() => ({
      sql: 'INSERT INTO db_test_string_widening (id, title, label) VALUES (@id, @title, @label)',
      namedParams: {
        params: { id, title: 'short title', label: 'keep' },
        types: { id: 'string', title: 'string', label: 'string' },
      },
    }));

    const widened = wideningTable('MAX');
    await tableManager.loadTable(widened);

    const columnMetadata = await tableManager.schemaMetadata.getColumnMetadata(widened);
    expect(columnMetadata['title'].type).toBe('STRING(MAX)');
    // The untouched NOT NULL column keeps its constraint through the alter pass.
    expect(columnMetadata['label'].isNullable).toBe(false);

    // Pre-existing row survives, and the column now accepts values beyond the old limit.
    const longTitle = 'x'.repeat(3000);
    await spannerDriver.runDml(() => ({
      sql: 'UPDATE db_test_string_widening SET title = @title WHERE id = @id',
      namedParams: { params: { id, title: longTitle }, types: { id: 'string', title: 'string' } },
    }));
    const rows = await spannerDriver.runQuery(() => ({
      sql: 'SELECT title, label FROM db_test_string_widening WHERE id = @id',
      namedParams: { params: { id }, types: { id: 'string' } },
    }));
    expect(rows[0].title).toBe(longTitle);
    expect(rows[0].label).toBe('keep');
  }, 60000);

  test('non-widening type changes still throw', async () => {
    const widened = wideningTable('MAX');
    await tableManager.loadTable(widened);

    const narrowed = wideningTable(255);
    await expect(tableManager.loadTable(narrowed)).rejects.toThrow(/Unable to change column types in Spanner/);
  }, 60000);
});
