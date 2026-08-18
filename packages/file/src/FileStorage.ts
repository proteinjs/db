import { ScopedRecord, getScopedDb } from '@proteinjs/user';
import { File } from './tables/FileTable';
import { tables } from './tables/tables';
import { FileStorageService, getFileStorageService } from './services/FileStorageService';
import { FileStorageDriver } from './FileStorageDriver';
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
   * Retrieves the metadata of a given file.
   * @param fileId - The `id` of the file.
   * @returns The file metadata.
   */
  async getFile(fileId: string): Promise<File> {
    const db = getScopedDb();
    const file = await db.get(tables.File, { id: fileId });
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
