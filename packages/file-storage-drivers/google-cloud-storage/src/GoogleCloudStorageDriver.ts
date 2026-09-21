import { Storage } from '@google-cloud/storage';
import { File, FileStorageDriver, FileStorageError } from '@proteinjs/db-file';
import {
  GoogleCloudStorageConfig,
  getDefaultGoogleCloudStorageConfigFactory,
} from './DefaultGoogleCloudStorageConfigFactory';

/** Signed URLs are short-lived read capabilities minted per serve — long enough to load and seek
 *  a video, short enough that a leaked URL goes stale quickly. */
const DEFAULT_SIGNED_URL_TTL_MS = 15 * 60 * 1000;

/** Failures of the connection itself, as Node names them — the store was never reached. */
const NETWORK_ERROR_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'];

/**
 * ERRORS: every operation runs inside {@link GoogleCloudStorageDriver.guarded}, so what leaves this
 * driver on a failure is a `FileStorageError` — a code, a plain message, the HTTP status — and
 * never the storage client's own error. The client's error holds the request it made (`config`,
 * `response.request`, `response.config`), and that request holds this driver's access token in its
 * `Authorization` header: an application that logged the error it caught would write a live
 * credential. A missing object is the `not-found` code on every read and overwrite.
 */
export class GoogleCloudStorageDriver implements FileStorageDriver {
  private storage: Storage;
  private bucketName: string;
  private objectPrefix: string;

  constructor(config?: GoogleCloudStorageConfig) {
    const { projectId, bucketName, objectPrefix, storageOptions } = config ? config : this.getDefaultConfig();
    this.storage = new Storage({ ...storageOptions, projectId });
    this.bucketName = bucketName;
    this.objectPrefix = objectPrefix ?? '';
  }

  async createFile(file: File, fileData: string): Promise<void> {
    const gcsFile = this.object(file.id);

    // The GCS object stores the file's TRUE bytes (the interface string is base64 transport).
    // Raw bytes at rest are what make signed-URL serving correct: the browser reads the object
    // directly, so base64 text at rest would corrupt every binary served that way.
    await this.guarded('createFile', file.id, () =>
      gcsFile.save(Buffer.from(fileData, 'base64'), {
        metadata: {
          contentType: file.type,
          metadata: {
            fileId: file.id,
            fileName: file.name,
            fileSize: file.size.toString(),
          },
        },
      })
    );
  }

  async getFileData(fileId: string): Promise<string> {
    const file = this.object(fileId);
    const [fileContent] = await this.guarded('getFileData', fileId, () => file.download());
    return fileContent.toString('base64');
  }

  async updateFileData(fileId: string, data: string): Promise<void> {
    const gcsFile = this.object(fileId);
    const bytes = Buffer.from(data, 'base64');

    // Writing an object's bytes creates a new generation, and a new generation holds only the
    // metadata sent with that write. The object is named by file id, so there is no extension to
    // infer a content type from: an overwrite that sends none is served as
    // `application/octet-stream`, and a browser following `GET /file/:id` downloads a picture
    // instead of showing it. So the overwrite restates what the object already says about
    // itself. `contentEncoding` is left out on purpose — it describes the bytes being replaced.
    const [existing] = await this.guarded('updateFileData', fileId, () => gcsFile.getMetadata());
    await this.guarded('updateFileData', fileId, () =>
      gcsFile.save(bytes, {
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
      })
    );
  }

  async updateFile(file: File): Promise<void> {
    const gcsFile = this.object(file.id);
    await this.guarded('updateFile', file.id, () =>
      gcsFile.setMetadata({
        contentType: file.type,
        metadata: {
          fileId: file.id,
          fileName: file.name,
          fileSize: file.size.toString(),
        },
      })
    );
  }

  async getSignedUrl(fileId: string, options?: { ttlMs?: number }): Promise<string> {
    const gcsFile = this.object(fileId);
    const [url] = await this.guarded('getSignedUrl', fileId, () =>
      gcsFile.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + (options?.ttlMs ?? DEFAULT_SIGNED_URL_TTL_MS),
      })
    );
    return url;
  }

  async deleteFile(fileId: string): Promise<void> {
    const gcsFile = this.object(fileId);
    // ignoreNotFound implements the driver contract's idempotency: a retried row delete must not
    // wedge because a prior attempt already removed the blob. Every other failure throws loudly.
    await this.guarded('deleteFile', fileId, () => gcsFile.delete({ ignoreNotFound: true }));
  }

  /**
   * THE one place an object's name is decided (`<objectPrefix><file id>`): every operation
   * addresses its object through here, so a configured prefix holds for all of them or none.
   */
  private object(fileId: string) {
    return this.storage.bucket(this.bucketName).file(`${this.objectPrefix}${fileId}`);
  }

  /**
   * THE one door a storage-client call leaves through. Whatever the client throws is replaced by
   * this driver's own error; nothing of the client's error object rides on it.
   */
  private async guarded<T>(operation: string, fileId: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (clientError: unknown) {
      throw this.driverError(operation, fileId, clientError);
    }
  }

  /**
   * Reads exactly three plain facts off the client's error — an HTTP status, a connection error
   * code, its message TEXT — and builds the driver's error from them. The client's error itself,
   * its `config`, `request`, `response` and `errors` are never copied, wrapped or kept as a cause.
   */
  private driverError(operation: string, fileId: string, clientError: unknown): FileStorageError {
    const status = this.httpStatus(clientError);
    const connectionFailed = NETWORK_ERROR_CODES.includes((clientError as { code?: unknown } | null)?.code as string);
    const message = (clientError as { message?: unknown } | null)?.message;
    return new FileStorageError(
      connectionFailed ? 'unavailable' : FileStorageError.codeForStatus(status),
      `${operation} failed for file ${fileId}`,
      { status, detail: typeof message === 'string' ? message : undefined }
    );
  }

  /** The client reports the HTTP status as its error's `code`; an upload's error carries it as `status` or on its `response`. */
  private httpStatus(clientError: unknown): number | undefined {
    const candidate = clientError as
      { code?: unknown; status?: unknown; response?: { status?: unknown; statusCode?: unknown } } | null | undefined;
    for (const value of [
      candidate?.code,
      candidate?.status,
      candidate?.response?.status,
      candidate?.response?.statusCode,
    ]) {
      const status = typeof value === 'string' && /^\d{3}$/.test(value) ? Number(value) : value;
      if (typeof status === 'number' && status >= 100 && status <= 599) {
        return status;
      }
    }
    return undefined;
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
