import { Reference, getDbAsSystem } from '@proteinjs/db';
import { getScopedDbAsSystem, ScopedRecord } from '@proteinjs/user';
import { File } from '../src/tables/FileTable';
import { tables } from '../src/tables/tables';
import { FileStorage } from '../src/FileStorage';
import { FileStorageDriver } from '../src/FileStorageDriver';
import { DbFileStorageDriver } from '../src/DbFileStorageDriver';
import { FileTestEnvironment } from './FileTestEnvironment';

/**
 * In-memory byte store shaped like the GoogleCloudStorageDriver: bytes keyed by file id,
 * reads of a missing object fail loudly (GCS 404 semantics).
 */
class TestMemoryFileStorageDriver implements FileStorageDriver {
  readonly store = new Map<string, string>();

  async createFile(file: File, fileData: string): Promise<void> {
    this.store.set(file.id, fileData);
  }

  async getFileData(fileId: string): Promise<string> {
    const data = this.store.get(fileId);
    if (data === undefined) {
      throw new Error(`No such object: ${fileId}`);
    }
    return data;
  }

  async updateFileData(fileId: string, data: string): Promise<void> {
    this.store.set(fileId, data);
  }

  async updateFile(_file: File): Promise<void> {}

  async deleteFile(fileId: string): Promise<void> {
    this.store.delete(fileId);
  }
}

const testEnv = new FileTestEnvironment();

beforeAll(async () => {
  await testEnv.beforeAll();
  const user = await testEnv.createUser({ name: 'File owner', email: 'file-owner@test.local' });
  testEnv.actAs(user);
});

afterAll(async () => {
  await testEnv.afterAll();
});

describe('FileStorage.deleteFile', () => {
  const driver = new TestMemoryFileStorageDriver();

  beforeAll(() => {
    testEnv.setDriver(driver);
  });

  it('deletes the stored bytes along with the file row', async () => {
    const fileStorage = new FileStorage();
    const file = await fileStorage.createFile({ name: 'a.txt', type: 'text/plain', size: 5 } as File, 'hello');
    expect(driver.store.has(file.id)).toBe(true);

    await fileStorage.deleteFile(file.id);

    expect(await getDbAsSystem().get(tables.File, { id: file.id })).toBeUndefined();
    expect(driver.store.has(file.id)).toBe(false);
  });

  it('deletes the stored bytes when file rows are deleted directly through Db.delete (system sweep path)', async () => {
    const fileStorage = new FileStorage();
    const file = await fileStorage.createFile({ name: 'b.txt', type: 'text/plain', size: 5 } as File, 'swept');
    expect(driver.store.has(file.id)).toBe(true);

    await getScopedDbAsSystem<File>().delete(tables.File, { id: file.id });

    expect(await getDbAsSystem().get(tables.File, { id: file.id })).toBeUndefined();
    expect(driver.store.has(file.id)).toBe(false);
  });

  it('deletes the preview file bytes through the reference cascade', async () => {
    const fileStorage = new FileStorage();
    const preview = await fileStorage.createFile({ name: 'c.gif.preview', type: 'image/png', size: 4 } as File, 'PREV');
    const file = await fileStorage.createFile(
      {
        name: 'c.gif',
        type: 'image/gif',
        size: 4,
        preview: new Reference<File>(tables.File.name, preview.id),
      } as Omit<File, keyof ScopedRecord>,
      'MAIN'
    );

    await fileStorage.deleteFile(file.id);

    expect(await getDbAsSystem().get(tables.File, { id: file.id })).toBeUndefined();
    expect(await getDbAsSystem().get(tables.File, { id: preview.id })).toBeUndefined();
    expect(driver.store.has(file.id)).toBe(false);
    expect(driver.store.has(preview.id)).toBe(false);
  });
});

describe('FileStorage.deleteFile with DbFileStorageDriver', () => {
  beforeAll(() => {
    // 4-byte chunks so a small payload exercises multi-chunk cleanup.
    testEnv.setDriver(new DbFileStorageDriver(4));
  });

  it('deletes all file_data chunk rows along with the file row', async () => {
    const fileStorage = new FileStorage();
    const file = await fileStorage.createFile({ name: 'd.txt', type: 'text/plain', size: 11 } as File, 'hello world');
    const chunksBefore = await getDbAsSystem().query(tables.FileData, { file: file.id });
    expect(chunksBefore.length).toBeGreaterThan(1);

    await fileStorage.deleteFile(file.id);

    expect(await getDbAsSystem().get(tables.File, { id: file.id })).toBeUndefined();
    expect(await getDbAsSystem().query(tables.FileData, { file: file.id })).toHaveLength(0);
  });

  it('deleteFile is idempotent: deleting bytes that are already gone succeeds', async () => {
    const fileStorage = new FileStorage();
    const file = await fileStorage.createFile({ name: 'e.txt', type: 'text/plain', size: 5 } as File, 'again');

    await fileStorage.deleteFile(file.id);
    await expect(FileStorage.getDriver().deleteFile(file.id)).resolves.toBeUndefined();
  });
});
