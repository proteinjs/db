import { Table } from '@proteinjs/db';
import { tableManagerTests } from '@proteinjs/db/test';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { SpannerColumnTypeFactory } from '../src/SpannerColumnTypeFactory';
import { getDropTestTable } from './util/getDropTestTable';
import '../generated/test/index';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

describe(
  'Table Manager Tests',
  tableManagerTests(spannerDriver, getDropTestTable(spannerDriver), new SpannerColumnTypeFactory().getType, {
    alterColumnName: true,
    alterColumnTypes: true,
  })
);

/**
 * The reader behind the shared age-out cases above, handed the information schema's text with no
 * database. Those cases register only where the driver's reader has `getDeleteRowsOlderThan`, so
 * the first case fails if this driver's reader loses it and they stop running; the second holds a
 * text the reader cannot read as an age-out that stands, never as none (none would send an ADD,
 * refused beside the standing one, at every start).
 */
describe('Table Manager: reading a table age-out back', () => {
  const readBack = async (expression: string | null) => {
    const driver = new SpannerDriver({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    jest.spyOn(driver, 'runQuery').mockResolvedValue([{ ROW_DELETION_POLICY_EXPRESSION: expression }]);
    const reader = driver.getTableManager().schemaMetadata;
    return await reader.getDeleteRowsOlderThan?.({ name: 'db_test_tm_visit' } as Table<any>);
  };

  test('the driver reads a standing age-out back as its column and days', async () => {
    expect(await readBack('OLDER_THAN(seen_at, INTERVAL 7 DAY)')).toEqual({ column: 'seen_at', days: 7 });
    expect(await readBack(null)).toBeNull();
  });

  test('a text the driver cannot read is an age-out that stands, never none', async () => {
    expect(await readBack('OLDER_THAN(seen_at, INTERVAL 168 HOUR)')).toEqual({
      unread: 'OLDER_THAN(seen_at, INTERVAL 168 HOUR)',
    });
  });
});
