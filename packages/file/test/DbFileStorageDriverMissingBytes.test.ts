import { QueryBuilderFactory, getDbAsSystem } from '@proteinjs/db';
import { User } from '@proteinjs/user';
import { File } from '../src/tables/FileTable';
import { tables } from '../src/tables/tables';
import { FileStorage } from '../src/FileStorage';
import { FileStorageError } from '../src/FileStorageError';
import { DbFileStorageDriver } from '../src/DbFileStorageDriver';
import { FileTestEnvironment } from './FileTestEnvironment';

/**
 * The driver contract has one answer for bytes that are not there: the `not-found` code. An
 * object store says it for a missing object; this driver's store is the chunk table, where
 * "nothing stored" and "an empty file" both used to read as zero chunk rows and came back as `''`
 * — so a caller could not tell a lost file from an empty one, and code that branched on the
 * object store's error never ran against this driver.
 */
const testEnv = new FileTestEnvironment();
const driver = new DbFileStorageDriver();
let owner: User;

beforeAll(async () => {
  await testEnv.beforeAll();
  testEnv.setDriver(driver);
  owner = await testEnv.createUser({ name: 'File owner', email: 'missing-bytes-owner@test.local' });
  testEnv.actAs(owner);
});

afterAll(async () => {
  await testEnv.afterAll();
});

const chunkRows = async (fileId: string) =>
  await getDbAsSystem().query(
    tables.FileData,
    new QueryBuilderFactory().getQueryBuilder(tables.FileData, { file: fileId })
  );

describe('DbFileStorageDriver reports bytes that are not there as not-found', () => {
  it('a file row whose bytes are gone is not-found, not an empty string', async () => {
    const bytes = Buffer.from('the bytes of a picture');
    const file = await new FileStorage().createFile(
      { name: 'holiday.jpg', type: 'image/jpeg', size: bytes.length } as File,
      bytes.toString('base64')
    );
    await driver.deleteFile(file.id);

    const failure = await driver.getFileData(file.id).catch((error) => error);

    expect(FileStorageError.isNotFound(failure)).toBe(true);
    expect(failure.message).toEqual(`getFileData failed for file ${file.id}: not-found`);
  });

  it('an id that names no file at all is not-found', async () => {
    const failure = await driver.getFileData('no-such-file-id').catch((error) => error);

    expect(FileStorageError.isNotFound(failure)).toBe(true);
  });

  it('an empty file is stored, and reads back as empty', async () => {
    const file = await new FileStorage().createFile({ name: 'empty.txt', type: 'text/plain', size: 0 } as File, '');

    expect(await chunkRows(file.id)).toHaveLength(1);
    expect(await driver.getFileData(file.id)).toEqual('');
  });

  it('a file overwritten with nothing stays stored, whatever its row says about its size', async () => {
    const bytes = Buffer.from('first');
    const file = await new FileStorage().createFile(
      { name: 'note.txt', type: 'text/plain', size: bytes.length } as File,
      bytes.toString('base64')
    );

    await driver.updateFileData(file.id, '');

    expect(await driver.getFileData(file.id)).toEqual('');
  });

  it('an empty file written before empty files had a chunk row still reads back as empty', async () => {
    const file = await new FileStorage().createFile({ name: 'old-empty.txt', type: 'text/plain', size: 0 } as File, '');
    await driver.deleteFile(file.id);
    expect(await chunkRows(file.id)).toHaveLength(0);

    expect(await driver.getFileData(file.id)).toEqual('');
  });
});
