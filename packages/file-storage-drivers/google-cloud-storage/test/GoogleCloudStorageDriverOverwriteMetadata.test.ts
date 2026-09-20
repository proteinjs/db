import { GoogleCloudStorageDriver } from '../src/GoogleCloudStorageDriver';

type StoredObject = {
  bytes: Buffer;
  generation: number;
  metadata: Record<string, any>;
};

/**
 * A small in-memory stand-in for the storage SDK that keeps the one service behaviour this suite
 * is about: writing an object's bytes creates a NEW GENERATION, and a new generation holds only
 * the metadata sent with that write — nothing of the previous generation's content type or custom
 * metadata survives by itself. With no content type sent, the SDK can only infer one from the
 * object name's extension; the driver names objects by file id, so there is none and the service
 * falls back to `application/octet-stream`.
 */
const objects = new Map<string, StoredObject>();
let nextGeneration = 1;
let afterMetadataRead: ((name: string) => void) | undefined;

const fileMock = jest.fn((name: string) => ({
  save: async (bytes: Buffer, options?: { metadata?: Record<string, any>; preconditionOpts?: Record<string, any> }) => {
    const existing = objects.get(name);
    const expectedGeneration = options?.preconditionOpts?.ifGenerationMatch;
    if (expectedGeneration !== undefined && String(existing?.generation ?? 0) !== String(expectedGeneration)) {
      throw Object.assign(new Error('conditionNotMet'), { code: 412 });
    }

    const sent = options?.metadata ?? {};
    objects.set(name, {
      bytes,
      generation: nextGeneration++,
      metadata: { ...sent, contentType: sent.contentType ?? 'application/octet-stream' },
    });
  },
  getMetadata: async () => {
    const existing = objects.get(name);
    if (!existing) {
      throw Object.assign(new Error(`No such object: ${name}`), { code: 404 });
    }

    const snapshot = { ...existing.metadata, generation: String(existing.generation) };
    afterMetadataRead?.(name);
    return [snapshot, {}];
  },
}));
const bucketMock = jest.fn(() => ({ file: fileMock }));

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(() => ({ bucket: bucketMock })),
}));

/**
 * `GET /file/:id` redirects the browser to the object itself, so the object's own content type is
 * what the browser is told. A byte overwrite that loses it turns every rewritten picture and clip
 * into an `application/octet-stream` download. The driver is the only party that talks to the
 * store, so the overwrite restates what the object already says about itself.
 */
describe('GoogleCloudStorageDriver.updateFileData keeps the object metadata', () => {
  const driver = new GoogleCloudStorageDriver({ projectId: 'test-project', bucketName: 'test-bucket' });
  const firstBytes = Buffer.from('first bytes of the picture');
  const nextBytes = Buffer.from('the same picture, rewritten smaller');

  beforeEach(() => {
    objects.clear();
    nextGeneration = 1;
    afterMetadataRead = undefined;
  });

  async function createPicture(id: string) {
    await driver.createFile(
      { id, name: 'holiday.jpg', type: 'image/jpeg', size: firstBytes.length } as never,
      firstBytes.toString('base64')
    );
  }

  it('an overwritten object keeps its content type', async () => {
    await createPicture('0b9c6d1e-object-id-without-extension');
    const before = objects.get('0b9c6d1e-object-id-without-extension')!.metadata.contentType;

    await driver.updateFileData('0b9c6d1e-object-id-without-extension', nextBytes.toString('base64'));

    const after = objects.get('0b9c6d1e-object-id-without-extension')!;
    expect(before).toEqual('image/jpeg');
    expect(after.metadata.contentType).toEqual('image/jpeg');
    expect(Buffer.compare(after.bytes, nextBytes)).toBe(0);
  });

  it('an overwritten object keeps its custom metadata, with the size restated for the new bytes', async () => {
    await createPicture('file-2');

    await driver.updateFileData('file-2', nextBytes.toString('base64'));

    expect(objects.get('file-2')!.metadata.metadata).toEqual({
      fileId: 'file-2',
      fileName: 'holiday.jpg',
      fileSize: nextBytes.length.toString(),
    });
  });

  it('an overwritten object keeps its cache, disposition and language headers', async () => {
    await createPicture('file-3');
    Object.assign(objects.get('file-3')!.metadata, {
      cacheControl: 'private, max-age=3600',
      contentDisposition: 'inline',
      contentLanguage: 'en',
    });

    await driver.updateFileData('file-3', nextBytes.toString('base64'));

    expect(objects.get('file-3')!.metadata).toMatchObject({
      contentType: 'image/jpeg',
      cacheControl: 'private, max-age=3600',
      contentDisposition: 'inline',
      contentLanguage: 'en',
    });
  });

  it('an overwrite that raced another writer fails loudly and leaves the other write in place', async () => {
    await createPicture('file-4');
    const otherWritersBytes = Buffer.from('another writer got there first');
    afterMetadataRead = (name) => {
      afterMetadataRead = undefined;
      const current = objects.get(name)!;
      objects.set(name, { ...current, bytes: otherWritersBytes, generation: nextGeneration++ });
    };

    await expect(driver.updateFileData('file-4', nextBytes.toString('base64'))).rejects.toMatchObject({
      name: 'FileStorageError',
      code: 'precondition-failed',
      status: 412,
    });

    expect(Buffer.compare(objects.get('file-4')!.bytes, otherWritersBytes)).toBe(0);
  });

  it('overwriting an object that does not exist fails loudly and creates nothing', async () => {
    await expect(driver.updateFileData('file-5', nextBytes.toString('base64'))).rejects.toMatchObject({
      name: 'FileStorageError',
      code: 'not-found',
      status: 404,
    });

    expect(objects.has('file-5')).toBe(false);
  });
});
