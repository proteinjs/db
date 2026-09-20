import { Storage } from '@google-cloud/storage';
import { File, FileStorageDriver } from '@proteinjs/db-file';
import {
  GoogleCloudStorageConfig,
  getDefaultGoogleCloudStorageConfigFactory,
} from './DefaultGoogleCloudStorageConfigFactory';

/** Signed URLs are short-lived read capabilities minted per serve — long enough to load and seek
 *  a video, short enough that a leaked URL goes stale quickly. */
const DEFAULT_SIGNED_URL_TTL_MS = 15 * 60 * 1000;

export class GoogleCloudStorageDriver implements FileStorageDriver {
  private storage: Storage;
  private bucketName: string;

  constructor(config?: GoogleCloudStorageConfig) {
    const { projectId, bucketName, storageOptions } = config ? config : this.getDefaultConfig();
    this.storage = new Storage({ ...storageOptions, projectId });
    this.bucketName = bucketName;
  }

  async createFile(file: File, fileData: string): Promise<void> {
    const bucket = this.storage.bucket(this.bucketName);
    const gcsFile = bucket.file(file.id);

    // The GCS object stores the file's TRUE bytes (the interface string is base64 transport).
    // Raw bytes at rest are what make signed-URL serving correct: the browser reads the object
    // directly, so base64 text at rest would corrupt every binary served that way.
    await gcsFile.save(Buffer.from(fileData, 'base64'), {
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
    return fileContent.toString('base64');
  }

  async updateFileData(fileId: string, data: string): Promise<void> {
    const gcsFile = this.storage.bucket(this.bucketName).file(fileId);
    const bytes = Buffer.from(data, 'base64');

    // Writing an object's bytes creates a new generation, and a new generation holds only the
    // metadata sent with that write. The object is named by file id, so there is no extension to
    // infer a content type from: an overwrite that sends none is served as
    // `application/octet-stream`, and a browser following `GET /file/:id` downloads a picture
    // instead of showing it. So the overwrite restates what the object already says about
    // itself. `contentEncoding` is left out on purpose — it describes the bytes being replaced.
    const [existing] = await gcsFile.getMetadata();
    await gcsFile.save(bytes, {
      metadata: {
        contentType: existing.contentType,
        cacheControl: existing.cacheControl,
        contentDisposition: existing.contentDisposition,
        contentLanguage: existing.contentLanguage,
        metadata: { ...existing.metadata, fileSize: bytes.length.toString() },
      },
      // The metadata read and the byte write are two requests. Pinning the write to the
      // generation that was read makes the pair one decision: an overwrite that raced another
      // writer fails loudly instead of restating metadata that is no longer the object's.
      preconditionOpts: { ifGenerationMatch: existing.generation },
    });
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

  async getSignedUrl(fileId: string, options?: { ttlMs?: number }): Promise<string> {
    const gcsFile = this.storage.bucket(this.bucketName).file(fileId);
    const [url] = await gcsFile.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + (options?.ttlMs ?? DEFAULT_SIGNED_URL_TTL_MS),
    });
    return url;
  }

  async deleteFile(fileId: string): Promise<void> {
    const gcsFile = this.storage.bucket(this.bucketName).file(fileId);
    // ignoreNotFound implements the driver contract's idempotency: a retried row delete must not
    // wedge because a prior attempt already removed the blob. Every other failure throws loudly.
    await gcsFile.delete({ ignoreNotFound: true });
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
}
