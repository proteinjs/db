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

  it('round-trips the rights record on a web-saved copy — licence name, deed URL and the credit sentence', async () => {
    const file = await new FileStorage().createFile(
      {
        name: 'fold.jpg',
        type: 'image/jpeg',
        size: 4,
        width: 4032,
        height: 3024,
        sourceUrl: 'https://upload.wikimedia.org/fold.jpg',
        sourcePageUrl: 'https://commons.wikimedia.org/w/index.php?curid=1',
        retrievedAt: new Date(),
        license: 'CC BY 3.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/3.0/',
        attribution: '"Samsung Galaxy Z Fold" by Ka Kit Pang is licensed under CC BY 3.0.',
      } as File,
      Buffer.from('fold').toString('base64')
    );

    const row = await getDbAsSystem().get(tables.File, { id: file.id });
    expect(row.license).toEqual('CC BY 3.0');
    expect(row.licenseUrl).toEqual('https://creativecommons.org/licenses/by/3.0/');
    expect(row.attribution).toEqual('"Samsung Galaxy Z Fold" by Ka Kit Pang is licensed under CC BY 3.0.');
    expect(row.sourcePageUrl).toEqual('https://commons.wikimedia.org/w/index.php?curid=1');
  });

  it('round-trips the producer record on a made picture — what kind of producer, and which model', async () => {
    const file = await new FileStorage().createFile(
      {
        name: 'mark.png',
        type: 'image/png',
        size: 4,
        width: 1024,
        height: 1024,
        origin: 'generation',
        originModel: 'example-image-model-1',
      } as File,
      Buffer.from('mark').toString('base64')
    );

    const row = await getDbAsSystem().get(tables.File, { id: file.id });
    expect(row.origin).toEqual('generation');
    expect(row.originModel).toEqual('example-image-model-1');
  });

  it('keeps a producer kind with no model — an upload has an origin and no originModel', async () => {
    const file = await new FileStorage().createFile(
      { name: 'photo.jpg', type: 'image/jpeg', size: 5, origin: 'upload' } as File,
      Buffer.from('photo').toString('base64')
    );

    const row = await getDbAsSystem().get(tables.File, { id: file.id });
    expect(row.origin).toEqual('upload');
    expect(row.originModel ?? undefined).toBeUndefined();
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
    expect(row.license ?? undefined).toBeUndefined();
    expect(row.attribution ?? undefined).toBeUndefined();
    expect(row.origin ?? undefined).toBeUndefined();
    expect(row.originModel ?? undefined).toBeUndefined();
  });
});
