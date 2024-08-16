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
  private static defaultDriver: FileStorageDriver;
  private driver: FileStorageDriver;
  private logger: Logger = new Logger({ name: this.constructor.name });

  public serviceMetadata = {
    auth: {
      allUsers: true,
    },
  };

  constructor(driver?: FileStorageDriver) {
    this.driver = driver ? driver : this.getDefaultDriver();
  }

  private getDefaultDriver(): FileStorageDriver {
    if (!FileStorage.defaultDriver) {
      const defaultDriverFactory = SourceRepository.get().object<DefaultFileStorageDriverFactory>(
        '@proteinjs/db-file/DefaultFileStorageDriverFactory'
      );
      if (defaultDriverFactory) {
        FileStorage.defaultDriver = defaultDriverFactory.getDriver();
      } else {
        this.logger.info({ message: `Defaulting to DbFileStorageDriver since no FileStorageDriver was provided` });
        FileStorage.defaultDriver = new DbFileStorageDriver();
      }
    }

    return FileStorage.defaultDriver;
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
    await this.driver.createFile(file, fileData);
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
    return await this.driver.getFileData(fileId);
  }

  /**
   * Updates the data chunks associated with a given file.
   * @param fileId - The `id` of the file.
   * @param data - The new data string to replace the existing data.
   */
  async updateFileData(fileId: string, data: string): Promise<void> {
    await this.driver.updateFileData(fileId, data);
  }

  /**
   * Updates the metadata of a given file.
   * @param file - The updated file to persist.
   */
  async updateFile(file: Omit<File, keyof ScopedRecord>): Promise<void> {
    const db = getScopedDb();
    await db.update(tables.File, file);

    if (this.driver.updateFile) {
      await this.driver.updateFile(file as File);
    }
  }

  /**
   * Deletes a file and its data.
   * The file data is deleted by a cascade delete rule defined on the `FileTable`
   * @param fileId - The `id` of the file to delete.
   */
  async deleteFile(fileId: string): Promise<void> {
    const db = getScopedDb();
    if (this.driver.deleteFile) {
      await this.driver.deleteFile(fileId);
    }

    await db.delete(tables.File, { id: fileId });
  }
}
