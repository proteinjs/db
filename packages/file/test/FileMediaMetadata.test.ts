import { getDbAsSystem } from '@proteinjs/db';
import { File } from '../src/tables/FileTable';
import { tables } from '../src/tables/tables';
import { FileStorage } from '../src/FileStorage';
import { FileStorageDriver } from '../src/FileStorageDriver';
import { FileTestEnvironment } from './FileTestEnvironment';

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

  async deleteFile(fileId: string): Promise<void> {
    this.store.delete(fileId);
  }
}

const testEnv = new FileTestEnvironment();

beforeAll(async () => {
  await testEnv.beforeAll();
  const user = await testEnv.createUser({ name: 'File owner', email: 'media-metadata@test.local' });
  testEnv.actAs(user);
  testEnv.setDriver(new TestMemoryFileStorageDriver());
});

afterAll(async () => {
  await testEnv.afterAll();
});

/**
 * Media metadata lives on the File row (`width`/`height`/`durationMs`) — generic file facts every
 * consumer needs to render without loading bytes (aspect-ratio-reserved layout). This proves the
 * columns persist and round-trip through the real schema on the emulator.
 */
describe('File media metadata columns', () => {
  it('round-trips width/height/durationMs on a media file', async () => {
    const file = await new FileStorage().createFile(
      { name: 'clip.mp4', type: 'video/mp4', size: 4, width: 1280, height: 720, durationMs: 24_500 } as File,
      Buffer.from('clip').toString('base64')
    );

    const row = await getDbAsSystem().get(tables.File, { id: file.id });
    expect(row.width).toEqual(1280);
    expect(row.height).toEqual(720);
    expect(row.durationMs).toEqual(24_500);
  });

  it('leaves the fields absent for non-media files', async () => {
    const file = await new FileStorage().createFile(
      { name: 'a.txt', type: 'text/plain', size: 5 } as File,
      Buffer.from('hello').toString('base64')
    );

    const row = await getDbAsSystem().get(tables.File, { id: file.id });
    expect(row.width ?? undefined).toBeUndefined();
    expect(row.height ?? undefined).toBeUndefined();
    expect(row.durationMs ?? undefined).toBeUndefined();
  });
});
