import { GoogleCloudStorageDriver } from '../src/GoogleCloudStorageDriver';

const deleteMock = jest.fn();
const fileMock = jest.fn(() => ({ delete: deleteMock }));
const bucketMock = jest.fn(() => ({ file: fileMock }));

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(() => ({ bucket: bucketMock })),
}));

/**
 * The driver is a thin adapter over the GCS SDK, so this asserts the adapter's contract against
 * a mocked SDK (tests never touch real GCS): the blob delete is issued idempotently
 * (ignoreNotFound — a retried row delete must not wedge on an already-deleted blob), and real
 * SDK failures propagate loudly instead of being swallowed.
 */
describe('GoogleCloudStorageDriver.deleteFile', () => {
  const driver = new GoogleCloudStorageDriver({ projectId: 'test-project', bucketName: 'test-bucket' });

  beforeEach(() => {
    deleteMock.mockReset();
  });

  it('deletes the blob for the file id, idempotently on missing blobs', async () => {
    deleteMock.mockResolvedValue(undefined);

    await driver.deleteFile('file-1');

    expect(bucketMock).toHaveBeenCalledWith('test-bucket');
    expect(fileMock).toHaveBeenCalledWith('file-1');
    expect(deleteMock).toHaveBeenCalledWith({ ignoreNotFound: true });
  });

  it('propagates real SDK failures loudly', async () => {
    deleteMock.mockRejectedValue(new Error('storage.objects.delete permission denied'));

    await expect(driver.deleteFile('file-2')).rejects.toThrow('storage.objects.delete permission denied');
  });
});
