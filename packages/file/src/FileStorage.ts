import { ScopedRecord, getScopedDb, getScopedDbAsSystem } from '@proteinjs/user';
import { File } from './tables/FileTable';
import { tables } from './tables/tables';
import { FileStorageService, getFileStorageService } from './services/FileStorageService';
import { FileStorageDriver } from './FileStorageDriver';
import { getFileReachabilityResolvers } from './FileReachabilityResolver';
import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { Logger } from '@proteinjs/logger';
import { DbFileStorageDriver } from './DbFileStorageDriver';

/**
 * A convenience factory function so code using this is portable (can be used in server or browser).
 * @returns an instance of the `FileStorageService` when called from the browser, and an instance of `FileStorage` otherwise
 * */
export const getFileStorage = () =>
  typeof self === 'undefined' ? new FileStorage() : (getFileStorageService() as FileStorage);

/**
 * A convenience factory to provide a default `FileStorageDriver`
 */
export interface DefaultFileStorageDriverFactory extends Loadable {
  getDriver(): FileStorageDriver;
}

/**
 * A simple api for file storage.
 * File metadata is stored in the `FileTable`.
 * File data is stored by the `FileStorageDriver`.
 */
export class FileStorage implements FileStorageService {
  private static driver: FileStorageDriver;

  public serviceMetadata = {
    auth: {
      allUsers: true,
    },
  };

  /**
   * The `FileStorageDriver` for this process — provided by the `DefaultFileStorageDriverFactory`
   * implementation, defaulting to the `DbFileStorageDriver`. One resolution for every byte
   * operation (`FileStorage` and `FileStorageTableWatcher`), so bytes always live and die in the
   * same store.
   */
  static getDriver(): FileStorageDriver {
    if (!FileStorage.driver) {
      const defaultDriverFactory = SourceRepository.get().object<DefaultFileStorageDriverFactory>(
        '@proteinjs/db-file/DefaultFileStorageDriverFactory'
      );
      if (defaultDriverFactory) {
        FileStorage.driver = defaultDriverFactory.getDriver();
      } else {
        new Logger({ name: 'FileStorage' }).info({
          message: `Defaulting to DbFileStorageDriver since no FileStorageDriver was provided`,
        });
        FileStorage.driver = new DbFileStorageDriver();
      }
    }

    return FileStorage.driver;
  }

  /**
   * Creates a new file record and its associated data chunks.
   * @param fileMetaData - The file metadata (name, type, size).
   * @param fileData - The file data as a string.
   * @returns The created file record.
   */
  async createFile(fileMetaData: Omit<File, keyof ScopedRecord>, fileData: string): Promise<File> {
    const db = getScopedDb();
    const file = await db.insert(tables.File, fileMetaData);
    await FileStorage.getDriver().createFile(file, fileData);
    return file;
  }

  /**
   * Retrieves the metadata of a given file — THE file-read access decision every serving path
   * derives from (`/file/:id`, signed-URL minting, the browser service).
   *
   * Two legs: the caller's own file resolves by the SCOPED read; when that misses, the
   * shared-content leg asks the registered {@link FileReachabilityResolver}s whether the caller
   * can read a row that REFERENCES the file (a shared thought's media node) — content access
   * confers file access, through the content's own grant-filtered read, never by widening file
   * scope. No resolver vouching means the miss stands. Reads only: writes/deletes stay scoped.
   * @param fileId - The `id` of the file.
   * @returns The file metadata, or `undefined` when the caller can neither own nor reach it.
   */
  async getFile(fileId: string): Promise<File> {
    const db = getScopedDb();
    const file = await db.get(tables.File, { id: fileId });
    if (file) {
      return file;
    }

    for (const resolver of getFileReachabilityResolvers()) {
      if (await resolver.canReadViaReference(fileId)) {
        // Reachability established through the caller's grant-filtered content read — the row
        // itself lives in the owner's scope, so it is served via system read.
        return await getScopedDbAsSystem().get(tables.File, { id: fileId });
      }
    }

    return file;
  }

  /**
   * Retrieves the data chunks associated with a given file.
   * @param fileId - The `id` of the file.
   * @returns The file data as a single string.
   */
  async getFileData(fileId: string): Promise<string> {
    return await FileStorage.getDriver().getFileData(fileId);
  }

  /**
   * Mint a short-lived, read-only URL for the file's bytes (server-only; not part of the
   * browser-facing `FileStorageService`). A signed URL is a bearer capability, so minting
   * verifies the caller can read the file row (the two-legged {@link getFile} read — own scope
   * or shared-content reachability) before signing.
   * @param fileId - The `id` of the file.
   * @param options.ttlMs - How long the URL stays valid; the driver applies its default when omitted.
   * @returns The signed URL, or `undefined` when the driver has no external URL space
   *          (`DbFileStorageDriver`) — the caller then serves bytes through the proxy route.
   * @throws When the file row does not exist or is not readable by the caller.
   */
  async getSignedUrl(fileId: string, options?: { ttlMs?: number }): Promise<string | undefined> {
    const file = await this.getFile(fileId);
    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    const driver = FileStorage.getDriver();
    if (!driver.getSignedUrl) {
      return undefined;
    }

    return await driver.getSignedUrl(fileId, options);
  }

  /**
   * Updates the data chunks associated with a given file.
   * @param fileId - The `id` of the file.
   * @param data - The new data string to replace the existing data.
   */
  async updateFileData(fileId: string, data: string): Promise<void> {
    await FileStorage.getDriver().updateFileData(fileId, data);
  }

  /**
   * Updates the metadata of a given file.
   * @param file - The updated file to persist.
   */
  async updateFile(file: Omit<File, keyof ScopedRecord>): Promise<void> {
    const db = getScopedDb();
    await db.update(tables.File, file);

    const driver = FileStorage.getDriver();
    if (driver.updateFile) {
      await driver.updateFile(file as File);
    }
  }

  /**
   * Deletes a file and its data.
   * The file data is deleted by the `FileStorageTableWatcher` when the row delete runs — the
   * watcher fires for every file-row delete path (this one, reference cascades, system sweeps),
   * so the bytes die with the row no matter where the delete originates.
   * @param fileId - The `id` of the file to delete.
   */
  async deleteFile(fileId: string): Promise<void> {
    const db = getScopedDb();
    await db.delete(tables.File, { id: fileId });
  }
}
