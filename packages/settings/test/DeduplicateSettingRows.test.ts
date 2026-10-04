import { Db, DuplicateValuesForUniqueIndexError, Record, Table, getDbAsSystem } from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { SpannerEmulatorProvisioner, getDropTestTable } from '@proteinjs/db-driver-spanner/test';
import moment from 'moment';
import { DeduplicateSettingRows } from '../src/migrations/DeduplicateSettingRows';
import { Setting, SettingTable } from '../src/tables/SettingTable';
import { tables } from '../src/tables/tables';
import '@proteinjs/db-transaction-context';
import '../generated/index';

/**
 * The data step that carries a live database to one row per name: over a setting table as it
 * stood before the unique index (duplicate rows of a (scope, name) in it), schema sync refuses to
 * add the index; the migration keeps the newest row of every (scope, name) — by `updated`, then
 * `created` — and deletes the rest, touching no other row; a second run deletes nothing; the index
 * then lands. On a database without the table it does nothing.
 */

const emulator = { projectId: 'proteinjs-test', instanceName: 'proteinjs-test', databaseName: 'test' };

describe('keeping one setting row per scope and name ahead of the unique index', () => {
  const systemDb = getDbAsSystem();
  const migration = new DeduplicateSettingRows().record;
  let driver: SpannerDriver;
  let dropTable: (table: Table<any>) => Promise<void>;

  const minutesAgo = (minutes: number) => moment().subtract(minutes, 'minutes');
  const seed = (row: Partial<Setting>) => systemDb.insert(tables.Setting, row as Omit<Setting, keyof Record>);
  const valuesLeft = async () =>
    (await systemDb.query(tables.Setting, {})).map((row) => `${row.scope}/${row.name}=${row.value}`).sort();

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned(emulator);
    driver = Db.getDefaultDbDriver() as SpannerDriver;
    dropTable = getDropTestTable(driver);
    await dropTable(tables.Setting);
    // The table as a database that predates the invariant holds it: no unique index.
    const beforeTheIndex = new SettingTable();
    beforeTheIndex.indexes = [];
    await driver.getTableManager().loadTable(beforeTheIndex);
  }, 120000);

  afterAll(async () => {
    await dropTable(tables.Setting);
    SpannerEmulatorProvisioner.release();
  }, 120000);

  test('keeps the newest row of each (scope, name), deletes the rest, and the index then lands', async () => {
    // ada/theme three times over: the newest by `updated` is the one written last, not the one created last.
    await seed({ scope: 'ada', name: 'theme', value: 'first', created: minutesAgo(30), updated: minutesAgo(30) });
    await seed({ scope: 'ada', name: 'theme', value: 'newest', created: minutesAgo(20), updated: minutesAgo(5) });
    await seed({ scope: 'ada', name: 'theme', value: 'middle', created: minutesAgo(10), updated: minutesAgo(10) });
    // ada/font twice with one `updated`: the later `created` is the newest.
    await seed({ scope: 'ada', name: 'font', value: 'serif', created: minutesAgo(20), updated: minutesAgo(1) });
    await seed({ scope: 'ada', name: 'font', value: 'sans', created: minutesAgo(15), updated: minutesAgo(1) });
    // One row each: untouched.
    await seed({ scope: 'ada', name: 'lang', value: 'en' });
    await seed({ scope: 'grace', name: 'theme', value: 'green' });

    await expect(driver.getTableManager().loadTable(tables.Setting)).rejects.toThrow(
      DuplicateValuesForUniqueIndexError
    );

    expect(await migration.estimate!()).toEqual({ units: 3, unit: 'rows' });
    expect(await migration.run()).toEqual({ deleted: 3 });
    expect(await valuesLeft()).toEqual(['ada/font=sans', 'ada/lang=en', 'ada/theme=newest', 'grace/theme=green']);

    expect(await migration.estimate!()).toEqual({ units: 0, unit: 'rows' });
    expect(await migration.run()).toEqual({ deleted: 0 });
    expect(await valuesLeft()).toEqual(['ada/font=sans', 'ada/lang=en', 'ada/theme=newest', 'grace/theme=green']);

    await driver.getTableManager().loadTable(tables.Setting);
    expect(await driver.getTableManager().schemaMetadata.getIndexes(tables.Setting)).toMatchObject({
      setting_scope_name_unique: ['scope', 'name'],
    });
  });

  test('a database without the table: nothing to do', async () => {
    await dropTable(tables.Setting);
    expect(await migration.estimate!()).toEqual({ units: 0, unit: 'rows' });
    expect(await migration.run()).toEqual({ deleted: 0 });
  });
});
