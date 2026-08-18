import { GoogleCloudStorageDriver } from '../src/GoogleCloudStorageDriver';

const getSignedUrlMock = jest.fn();
const fileMock = jest.fn(() => ({ getSignedUrl: getSignedUrlMock }));
const bucketMock = jest.fn(() => ({ file: fileMock }));

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(() => ({ bucket: bucketMock })),
}));

/**
 * Signed URLs are the serving path (GET /file/:id 302-redirects to them): read-only, short-lived
 * v4 URLs minted per request. The driver is a thin adapter, so this asserts the adapter's
 * contract against a mocked SDK: read action, v4 signing, TTL-derived expiry (default and
 * caller-provided), and loud failure propagation.
 */
describe('GoogleCloudStorageDriver.getSignedUrl', () => {
  const driver = new GoogleCloudStorageDriver({ projectId: 'test-project', bucketName: 'test-bucket' });
  const now = 1755400000000;

  beforeEach(() => {
    getSignedUrlMock.mockReset();
    fileMock.mockClear();
    bucketMock.mockClear();
    jest.spyOn(Date, 'now').mockReturnValue(now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('mints a read-only v4 URL with the default 15-minute TTL', async () => {
    getSignedUrlMock.mockResolvedValue(['https://storage.googleapis.com/test-bucket/file-1?signed']);

    const url = await driver.getSignedUrl('file-1');

    expect(bucketMock).toHaveBeenCalledWith('test-bucket');
    expect(fileMock).toHaveBeenCalledWith('file-1');
    expect(getSignedUrlMock).toHaveBeenCalledWith({
      version: 'v4',
      action: 'read',
      expires: now + 15 * 60 * 1000,
    });
    expect(url).toEqual('https://storage.googleapis.com/test-bucket/file-1?signed');
  });

  it('honors a caller-provided TTL', async () => {
    getSignedUrlMock.mockResolvedValue(['https://storage.googleapis.com/test-bucket/file-2?signed']);

    await driver.getSignedUrl('file-2', { ttlMs: 60_000 });

    expect(getSignedUrlMock).toHaveBeenCalledWith({
      version: 'v4',
      action: 'read',
      expires: now + 60_000,
    });
  });

  it('propagates real SDK failures loudly', async () => {
    getSignedUrlMock.mockRejectedValue(new Error('iam.serviceAccounts.signBlob permission denied'));

    await expect(driver.getSignedUrl('file-3')).rejects.toThrow('iam.serviceAccounts.signBlob permission denied');
  });
});
