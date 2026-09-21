import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { StorageOptions } from '@google-cloud/storage';

export const getDefaultGoogleCloudStorageConfigFactory = () =>
  SourceRepository.get().object<DefaultGoogleCloudStorageConfigFactory>(
    '@proteinjs/db-file-storage-driver-gcs/DefaultGoogleCloudStorageConfigFactory'
  );

export type GoogleCloudStorageConfig = {
  bucketName: string;
  projectId: string;
  /**
   * Prepended, verbatim, to the name of every object this driver writes, reads, signs or deletes
   * (`<objectPrefix><file id>`). Lets several independent deployments share one bucket while each
   * deployment's files stay listable and removable as a group. Include the separator yourself
   * (`'deployment-a/'`). Unset: an object is named by the file id alone.
   */
  objectPrefix?: string;
  storageOptions?: StorageOptions;
};

export interface DefaultGoogleCloudStorageConfigFactory extends Loadable {
  getConfig(): GoogleCloudStorageConfig;
}
