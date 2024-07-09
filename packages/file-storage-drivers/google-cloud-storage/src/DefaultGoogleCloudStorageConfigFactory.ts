import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { StorageOptions } from '@google-cloud/storage';

export const getDefaultGoogleCloudStorageConfigFactory = () =>
  SourceRepository.get().object<DefaultGoogleCloudStorageConfigFactory>(
    '@proteinjs/db-file-storage-driver-gcs/DefaultGoogleCloudStorageConfigFactory'
  );

export type GoogleCloudStorageConfig = {
  bucketName: string;
  projectId: string;
  storageOptions?: StorageOptions;
};

export interface DefaultGoogleCloudStorageConfigFactory extends Loadable {
  getConfig(): GoogleCloudStorageConfig;
}
