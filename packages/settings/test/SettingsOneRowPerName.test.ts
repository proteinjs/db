import { Db, Table, getDbAsSystem, isDuplicateKeyError } from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { SpannerEmulatorProvisioner, getDropTestTable } from '@proteinjs/db-driver-spanner/test';
import { Settings } from '../src/Settings';
import { tables } from '../src/tables/tables';
import { HeldFirstWriteDriver } from './util/HeldFirstWriteDriver';
import { TestSession } from './util/TestSession';
import '@proteinjs/db-transaction-context';
import '../generated/index';

/**
 * One setting row per name within a scope, on the real stack (the Spanner emulator, the default
 * driver and transaction context resolved through reflection — the path `getScopedDb` takes in
 * production): two concurrent `set`s of a fresh name — each observing no row before either
 * writes, the interleaving that created two rows — leave ONE row, `get` reads its value, a later
 * `set` rewrites that row, the table's unique index refuses a second row of the name in the scope
 * by its typed error, and the same name in another scope is another person's row.
 */

const emulator = { projectId: 'proteinjs-test', instanceName: 'proteinjs-test', databaseName: 'test' };
const ada = { id: 'settings-test-ada', email: 'ada@settings.test', name: 'Ada' };
const grace = { id: 'settings-test-grace', email: 'grace@settings.test', name: 'Grace' };

describe('one setting row per name within a scope', () => {
  const settings = new Settings();
  const systemDb = getDbAsSystem();
  let driver: SpannerDriver;
  let dropTable: (table: Table<any>) => Promise<void>;

  const rowsOf = (scope: string, name: string) => systemDb.query(tables.Setting, { scope, name });

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned(emulator);
    driver = Db.getDefaultDbDriver() as SpannerDriver;
    dropTable = getDropTestTable(driver);
    await dropTable(tables.Setting);
    await driver.getTableManager().loadTable(tables.Setting);
    TestSession.as(ada);
  }, 120000);

  afterAll(async () => {
    await dropTable(tables.Setting);
    SpannerEmulatorProvisioner.release();
  }, 120000);

  test('two concurrent sets of a fresh name, each observing no row before either writes, leave one row', async () => {
    // Every `set` builds its db on the default driver: both writers' first writes are held until
    // both have reached one, then run — neither can see the other's row before it writes.
    const held = new HeldFirstWriteDriver(driver, 2);
    const defaultDriver = jest.spyOn(Db, 'getDefaultDbDriver').mockImplementation(() => held);
    try {
      await Promise.all([settings.set('theme', 'dark'), settings.set('theme', 'light')]);
    } finally {
      defaultDriver.mockRestore();
    }
    const rows = await rowsOf(ada.id, 'theme');
    expect(rows.length).toBe(1);
    expect(['dark', 'light']).toContain(rows[0].value);
    expect(await settings.get('theme')).toBe(rows[0].value);
  });

  test('a later set rewrites the one row', async () => {
    await settings.set('theme', 'blue');
    expect((await rowsOf(ada.id, 'theme')).map((row) => row.value)).toEqual(['blue']);
    expect(await settings.get('theme')).toBe('blue');
  });

  test('the unique index refuses a second row of the name in the scope by its typed error', async () => {
    let refusal: unknown;
    try {
      await systemDb.insert(tables.Setting, { scope: ada.id, name: 'theme', value: 'red' });
    } catch (error) {
      refusal = error;
    }
    expect(isDuplicateKeyError(refusal)).toBe(true);
    expect((await rowsOf(ada.id, 'theme')).map((row) => row.value)).toEqual(['blue']);
  });

  test('the same name in another scope is another row', async () => {
    TestSession.as(grace);
    await settings.set('theme', 'green');
    expect(await settings.get('theme')).toBe('green');
    expect((await rowsOf(grace.id, 'theme')).map((row) => row.value)).toEqual(['green']);
    expect((await rowsOf(ada.id, 'theme')).map((row) => row.value)).toEqual(['blue']);
  });
});
