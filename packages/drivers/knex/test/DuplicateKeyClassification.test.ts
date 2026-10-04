import { KnexDriver } from '@proteinjs/db-driver-knex';

/**
 * Which failures this driver classifies as a duplicate key (`DbDriver.isDuplicateKeyError`, what
 * `Db.insert` turns into the typed `DuplicateKeyError`): MySQL's ER_DUP_ENTRY, the `code` the
 * vendor error carries (rethrown untouched by runQuery) — and nothing else.
 */

const driver = new KnexDriver({
  host: 'localhost',
  user: 'root',
  password: '',
  dbName: 'test',
});

const vendorError = (code: string, errno: number, message: string) =>
  Object.assign(new Error(message), { code, errno });

describe('the duplicate-key classification', () => {
  test('ER_DUP_ENTRY', () => {
    expect(
      driver.isDuplicateKeyError(
        vendorError('ER_DUP_ENTRY', 1062, "Duplicate entry 'a-theme' for key 'setting_scope_name_unique'")
      )
    ).toBe(true);
  });

  test('no other vendor code, and no error without a code', () => {
    expect(
      driver.isDuplicateKeyError(vendorError('ER_NO_SUCH_TABLE', 1146, "Table 'test.setting' doesn't exist"))
    ).toBe(false);
    expect(driver.isDuplicateKeyError(vendorError('ER_LOCK_DEADLOCK', 1213, 'Deadlock found'))).toBe(false);
    expect(driver.isDuplicateKeyError(new Error('Duplicate entry'))).toBe(false);
    expect(driver.isDuplicateKeyError(undefined)).toBe(false);
    expect(driver.isDuplicateKeyError(null)).toBe(false);
  });
});
