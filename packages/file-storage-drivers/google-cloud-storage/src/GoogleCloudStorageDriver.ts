import { Storage } from '@google-cloud/storage';
import { File, FileStorageDriver } from '@proteinjs/db-file';
import {
  GoogleCloudStorageConfig,
  getDefaultGoogleCloudStorageConfigFactory,
} from './DefaultGoogleCloudStorageConfigFactory';

export class GoogleCloudStorageDriver implements FileStorageDriver {
  private storage: Storage;
  private bucketName: string;

  constructor(config?: GoogleCloudStorageConfig) {
    const { projectId, bucketName, storageOptions } = config ? config : this.getDefaultConfig();
    this.storage = new Storage({ ...storageOptions, projectId });
    this.bucketName = bucketName;
  }

  private getDefaultConfig(): GoogleCloudStorageConfig {
    const defaultConfigFactory = getDefaultGoogleCloudStorageConfigFactory();
    if (!defaultConfigFactory) {
      throw new Error(
        `Unable to find a @proteinjs/db-file-storage-driver-gcs/DefaultGoogleCloudStorageConfigFactory implementation. Either implement DefaultGoogleCloudStorageConfigFactory or pass in a config when instantiating GoogleCloudStorageDriver.`
      );
    }

    return defaultConfigFactory.getConfig();
  }

  async createFile(file: File, fileData: string): Promise<void> {
    const bucket = this.storage.bucket(this.bucketName);
    const gcsFile = bucket.file(file.id);

    await gcsFile.save(fileData, {
      metadata: {
        contentType: file.type,
        metadata: {
          fileId: file.id,
          fileName: file.name,
          fileSize: file.size.toString(),
        },
      },
    });
  }

  async getFileData(fileId: string): Promise<string> {
    const file = this.storage.bucket(this.bucketName).file(fileId);
    const [fileContent] = await file.download();
    return fileContent.toString();
  }

  async updateFileData(fileId: string, data: string): Promise<void> {
    const file = this.storage.bucket(this.bucketName).file(fileId);
    await file.save(data);
  }

  async updateFile(file: File): Promise<void> {
    const gcsFile = this.storage.bucket(this.bucketName).file(file.id);
    await gcsFile.setMetadata({
      contentType: file.type,
      metadata: {
        fileId: file.id,
        fileName: file.name,
        fileSize: file.size.toString(),
      },
    });
  }
}
