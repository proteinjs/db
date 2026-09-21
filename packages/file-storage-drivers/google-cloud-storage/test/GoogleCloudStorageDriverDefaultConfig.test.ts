import { SourceRepository } from '@proteinjs/reflection';
import { GoogleCloudStorageDriver } from '../src/GoogleCloudStorageDriver';
import type {
  DefaultGoogleCloudStorageConfigFactory,
  GoogleCloudStorageConfig,
} from '../src/DefaultGoogleCloudStorageConfigFactory';

/** An in-memory bucket keyed by OBJECT NAME: whatever name the driver decides is the key here. */
const objects = new Map<string, Buffer>();
const buckets: string[] = [];

const fileMock = jest.fn((name: string) => ({
  save: async (bytes: Buffer) => {
    objects.set(name, bytes);
  },
  download: async () => {
    const existing = objects.get(name);
    if (!existing) {
      throw Object.assign(new Error(`No such object: ${name}`), { code: 404 });
    }
    return [existing];
  },
  getSignedUrl: async () => [`https://storage.example/${name}?signed`],
  delete: async () => {
    objects.delete(name);
  },
}));

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(() => ({
    bucket: (name: string) => {
      buckets.push(name);
      return { file: fileMock };
    },
  })),
}));

const FACTORY_TYPE = '@proteinjs/db-file-storage-driver-gcs/DefaultGoogleCloudStorageConfigFactory';
type SourceRepositoryInternals = { objectCache: Record<string, unknown[]> };

/**
 * An application rarely hands the driver a config: it implements
 * `DefaultGoogleCloudStorageConfigFactory` and the framework builds `new GoogleCloudStorageDriver()`
 * with NO argument. That is the path most deployments run, so it is the path the prefix has to hold
 * on: a prefix honoured only for an explicit config would leave those deployments writing bare ids
 * while believing their files are grouped.
 */
describe('GoogleCloudStorageDriver built from the default config factory (no constructor argument)', () => {
  const bytes = Buffer.from('the bytes of a picture');
  const picture = (id: string) => ({ id, name: 'holiday.jpg', type: 'image/jpeg', size: bytes.length }) as never;
  const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;
  /** The implementation an application would ship, seeded where the framework looks it up. */
  const implementFactory = (config: GoogleCloudStorageConfig) => {
    const factory: DefaultGoogleCloudStorageConfigFactory = { getConfig: () => config } as never;
    objectCache()[FACTORY_TYPE] = [factory];
  };

  beforeEach(() => {
    objects.clear();
    buckets.length = 0;
  });

  afterEach(() => {
    delete objectCache()[FACTORY_TYPE];
  });

  it('honours the factory’s objectPrefix on every operation: write, read, sign, delete', async () => {
    implementFactory({ projectId: 'test-project', bucketName: 'test-bucket', objectPrefix: 'deployment-a/' });
    const driver = new GoogleCloudStorageDriver();

    await driver.createFile(picture('file-1'), bytes.toString('base64'));
    expect(Array.from(objects.keys())).toEqual(['deployment-a/file-1']);
    expect(buckets).toEqual(['test-bucket']);

    expect(await driver.getFileData('file-1')).toBe(bytes.toString('base64'));
    expect(await driver.getSignedUrl('file-1')).toBe('https://storage.example/deployment-a/file-1?signed');

    await driver.deleteFile('file-1');
    expect(Array.from(objects.keys())).toEqual([]);
  });

  it('a default-config driver and an explicit-config driver with the same prefix reach the same object', async () => {
    const config = { projectId: 'test-project', bucketName: 'test-bucket', objectPrefix: 'deployment-a/' };
    implementFactory(config);
    await new GoogleCloudStorageDriver().createFile(picture('file-1'), bytes.toString('base64'));

    expect(await new GoogleCloudStorageDriver(config).getFileData('file-1')).toBe(bytes.toString('base64'));
  });

  it('a factory that names no prefix keeps objects at the file id alone', async () => {
    implementFactory({ projectId: 'test-project', bucketName: 'test-bucket' });

    await new GoogleCloudStorageDriver().createFile(picture('file-1'), bytes.toString('base64'));

    expect(Array.from(objects.keys())).toEqual(['file-1']);
  });
});
