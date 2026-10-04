import { SpannerDriver, SpannerOperationError } from '@proteinjs/db-driver-spanner';

/**
 * Which data-operation failures this driver classifies as a duplicate key (`DbDriver.isDuplicateKeyError`,
 * what `Db.insert` turns into the typed `DuplicateKeyError`): gRPC ALREADY_EXISTS (6), as the
 * vendor error carries it and as the driver's own typed error copies it — and nothing else, so an
 * ABORTED the runner retries, a FAILED_PRECONDITION or a deadline never reads as a row already
 * there. The refusal itself, on the emulator, is the settings package's one-row-per-name suite's.
 */

const driver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

const vendorError = (code: number, message: string) => Object.assign(new Error(message), { code });

describe('the duplicate-key classification', () => {
  test('ALREADY_EXISTS on the vendor error, and on the typed error that wraps it', () => {
    const refusal = vendorError(6, 'Unique index violation on index setting_scope_name_unique at index key [...]');
    expect(driver.isDuplicateKeyError(refusal)).toBe(true);
    expect(driver.isDuplicateKeyError(new SpannerOperationError('dml', { operation: 'INSERT' }, refusal))).toBe(true);
  });

  test('no other status, and no error without a status', () => {
    expect(driver.isDuplicateKeyError(vendorError(10, 'Transaction was aborted'))).toBe(false);
    expect(driver.isDuplicateKeyError(vendorError(9, 'Duplicate name in schema: setting'))).toBe(false);
    expect(driver.isDuplicateKeyError(vendorError(4, 'Deadline exceeded'))).toBe(false);
    expect(driver.isDuplicateKeyError(new Error('already exists'))).toBe(false);
    expect(driver.isDuplicateKeyError(undefined)).toBe(false);
    expect(driver.isDuplicateKeyError(null)).toBe(false);
  });
});
