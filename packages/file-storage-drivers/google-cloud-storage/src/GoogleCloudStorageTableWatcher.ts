import { Storage } from '@google-cloud/storage';
import { QueryBuilder, Table, TableWatcher } from '@proteinjs/db';
import { File, FileTable } from '@proteinjs/db-file';
import { Logger } from '@proteinjs/logger';
import {
  GoogleCloudStorageConfig,
  getDefaultGoogleCloudStorageConfigFactory,
} from './DefaultGoogleCloudStorageConfigFactory';

export class GoogleCloudStorageTableWatcher implements TableWatcher<File> {
  private logger = new Logger({ name: this.constructor.name });
  private storage: Storage;
  private bucketName: string;

  constructor() {
    const { projectId, bucketName, storageOptions } = this.getConfig();
    this.storage = new Storage({ ...storageOptions, projectId });
    this.bucketName = bucketName;
  }

  private getConfig(): GoogleCloudStorageConfig {
    const defaultConfigFactory = getDefaultGoogleCloudStorageConfigFactory();
    if (!defaultConfigFactory) {
      throw new Error(
        `Unable to find a @proteinjs/db-file-storage-driver-gcs/DefaultGoogleCloudStorageConfigFactory implementation when creating GoogleCloudStorageTableWatcher`
      );
    }

    return defaultConfigFactory.getConfig();
  }

  name(): string {
    return this.constructor.name;
  }

  table(): Table<File> {
    return new FileTable();
  }

  async beforeDelete<T extends File>(recordsToDelete: T[], qb: QueryBuilder<T>): Promise<void> {
    const fileIdsToDelete = recordsToDelete.map((record) => record.id);
    for (const fileId of fileIdsToDelete) {
      const file = this.storage.bucket(this.bucketName).file(fileId);
      await file.delete();
    }

    this.logger.info({
      message: `Deleted the following files from Google Cloud Storage`,
      obj: { deletedFileIds: fileIdsToDelete },
    });
  }
}
