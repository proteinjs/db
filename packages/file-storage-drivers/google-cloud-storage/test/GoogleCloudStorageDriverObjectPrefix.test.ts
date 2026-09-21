import { GoogleCloudStorageDriver } from '../src/GoogleCloudStorageDriver';

type StoredObject = { bytes: Buffer; generation: number; metadata: Record<string, any> };

/**
 * An in-memory bucket keyed by OBJECT NAME — the one fact this suite is about. Every storage call
 * the driver makes goes through `bucket.file(name)`, so whatever name the driver decides is the
 * key an object is stored, read, signed and deleted under here.
 */
const objects = new Map<string, StoredObject>();
let nextGeneration = 1;

const fileMock = jest.fn((name: string) => ({
  save: async (bytes: Buffer, options?: { metadata?: Record<string, any> }) => {
    objects.set(name, { bytes, generation: nextGeneration++, metadata: { ...(options?.metadata ?? {}) } });
  },
  download: async () => {
    const existing = objects.get(name);
    if (!existing) {
      throw Object.assign(new Error(`No such object: ${name}`), { code: 404 });
    }
    return [existing.bytes];
  },
  getMetadata: async () => {
    const existing = objects.get(name);
    if (!existing) {
      throw Object.assign(new Error(`No such object: ${name}`), { code: 404 });
    }
    return [{ ...existing.metadata, generation: String(existing.generation) }, {}];
  },
  setMetadata: async (metadata: Record<string, any>) => {
    const existing = objects.get(name);
    if (!existing) {
      throw Object.assign(new Error(`No such object: ${name}`), { code: 404 });
    }
    existing.metadata = { ...existing.metadata, ...metadata };
  },
  getSignedUrl: async () => [`https://storage.example/test-bucket/${name}?signed`],
  delete: async () => {
    objects.delete(name);
  },
}));
const bucketMock = jest.fn(() => ({ file: fileMock }));

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(() => ({ bucket: bucketMock })),
}));

/**
 * One bucket can hold the files of several independent deployments of an application — each a
 * driver with its own `objectPrefix`. The prefix is only worth having if EVERY operation honours
 * it: an object written under a prefix and read, signed or deleted by its bare id is a file that
 * cannot be found, and a deployment's files could not be listed or removed as a group.
 */
describe('GoogleCloudStorageDriver objectPrefix', () => {
  const bytes = Buffer.from('the bytes of a picture');
  const picture = (id: string) => ({ id, name: 'holiday.jpg', type: 'image/jpeg', size: bytes.length }) as never;

  beforeEach(() => {
    objects.clear();
    nextGeneration = 1;
  });

  it('stores a file under the prefix, never under its bare id', async () => {
    const driver = new GoogleCloudStorageDriver({
      projectId: 'test-project',
      bucketName: 'test-bucket',
      objectPrefix: 'deployment-a/',
    });

    await driver.createFile(picture('file-1'), bytes.toString('base64'));

    expect(Array.from(objects.keys())).toEqual(['deployment-a/file-1']);
    // The file's own id is what the object says about itself — the prefix names where, not what.
    expect(objects.get('deployment-a/file-1')!.metadata.metadata.fileId).toBe('file-1');
  });

  it('every operation reaches the object it wrote: read, overwrite, describe, sign, delete', async () => {
    const driver = new GoogleCloudStorageDriver({
      projectId: 'test-project',
      bucketName: 'test-bucket',
      objectPrefix: 'deployment-a/',
    });
    await driver.createFile(picture('file-1'), bytes.toString('base64'));

    expect(await driver.getFileData('file-1')).toBe(bytes.toString('base64'));

    const rewritten = Buffer.from('the same picture, rewritten');
    await driver.updateFileData('file-1', rewritten.toString('base64'));
    expect(objects.get('deployment-a/file-1')!.bytes.equals(rewritten)).toBe(true);

    await driver.updateFile({ id: 'file-1', name: 'renamed.jpg', type: 'image/jpeg', size: rewritten.length } as never);
    expect(objects.get('deployment-a/file-1')!.metadata.metadata.fileName).toBe('renamed.jpg');

    expect(await driver.getSignedUrl('file-1')).toBe('https://storage.example/test-bucket/deployment-a/file-1?signed');

    await driver.deleteFile('file-1');
    expect(Array.from(objects.keys())).toEqual([]);
  });

  it('two prefixes in one bucket never reach each other’s files', async () => {
    const a = new GoogleCloudStorageDriver({
      projectId: 'test-project',
      bucketName: 'test-bucket',
      objectPrefix: 'deployment-a/',
    });
    const b = new GoogleCloudStorageDriver({
      projectId: 'test-project',
      bucketName: 'test-bucket',
      objectPrefix: 'deployment-b/',
    });
    await a.createFile(picture('file-1'), bytes.toString('base64'));

    await expect(b.getFileData('file-1')).rejects.toMatchObject({ code: 'not-found' });
    await b.deleteFile('file-1');

    expect(Array.from(objects.keys())).toEqual(['deployment-a/file-1']);
  });

  it('with no prefix configured an object is named by the file id alone', async () => {
    const driver = new GoogleCloudStorageDriver({ projectId: 'test-project', bucketName: 'test-bucket' });

    await driver.createFile(picture('file-1'), bytes.toString('base64'));

    expect(Array.from(objects.keys())).toEqual(['file-1']);
    expect(await driver.getFileData('file-1')).toBe(bytes.toString('base64'));
  });
});
