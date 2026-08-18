import { GoogleCloudStorageDriver } from '../src/GoogleCloudStorageDriver';

const saveMock = jest.fn();
const downloadMock = jest.fn();
const fileMock = jest.fn(() => ({ save: saveMock, download: downloadMock }));
const bucketMock = jest.fn(() => ({ file: fileMock }));

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(() => ({ bucket: bucketMock })),
}));

/**
 * The FileStorageDriver contract: `fileData` strings crossing the interface are base64 of the
 * file's TRUE bytes, and the GCS object stores the true bytes — never base64 text. That at-rest
 * shape is what signed-URL serving (GET /file/:id 302 redirect) depends on: GCS hands the browser
 * the real bytes with the stored contentType, so binaries (video, pdf, gif) arrive byte-identical
 * without transiting the app server.
 */
describe('GoogleCloudStorageDriver byte encoding', () => {
  const driver = new GoogleCloudStorageDriver({ projectId: 'test-project', bucketName: 'test-bucket' });
  // Every byte value once — a payload that corrupts under any text/base64 mix-up.
  const rawBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const base64 = rawBytes.toString('base64');

  beforeEach(() => {
    saveMock.mockReset();
    downloadMock.mockReset();
    fileMock.mockClear();
    bucketMock.mockClear();
  });

  it('createFile stores the decoded true bytes (not base64 text), keeping the content metadata', async () => {
    saveMock.mockResolvedValue(undefined);

    await driver.createFile(
      { id: 'file-1', name: 'clip.mp4', type: 'video/mp4', size: rawBytes.length } as never,
      base64
    );

    expect(fileMock).toHaveBeenCalledWith('file-1');
    const [storedData, saveOptions] = saveMock.mock.calls[0];
    expect(Buffer.isBuffer(storedData)).toBe(true);
    expect(Buffer.compare(storedData, rawBytes)).toBe(0);
    expect(saveOptions.metadata.contentType).toEqual('video/mp4');
  });

  it('getFileData returns base64 of the stored true bytes', async () => {
    downloadMock.mockResolvedValue([rawBytes]);

    const fileData = await driver.getFileData('file-1');

    expect(fileData).toEqual(base64);
    expect(Buffer.compare(Buffer.from(fileData, 'base64'), rawBytes)).toBe(0);
  });

  it('updateFileData stores the decoded true bytes', async () => {
    saveMock.mockResolvedValue(undefined);

    await driver.updateFileData('file-1', base64);

    const [storedData] = saveMock.mock.calls[0];
    expect(Buffer.isBuffer(storedData)).toBe(true);
    expect(Buffer.compare(storedData, rawBytes)).toBe(0);
  });
});
