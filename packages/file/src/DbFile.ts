import { ScopedRecord, getScopedDb } from '@proteinjs/user';
import { QueryBuilderFactory, Reference } from '@proteinjs/db';
import { File } from './tables/FileTable';
import { tables } from './tables/tables';
import { DbFileService, getDbFileService } from './services/DbFileService';

/**
 * A convenience factory function so code using this is portable (can be used in server or browser).
 * @returns an instance of the `DbFileService` when called from the browser, and an instance of `DbFile` otherwise
 * */
export const getDbFile = () => (typeof self === 'undefined' ? new DbFile() : (getDbFileService() as DbFile));

/**
 * A simple api for reading/writing files to the db.
 * The storage is defined in `FileTable` and `FileDataTable`.
 */
export class DbFile implements DbFileService {
  public serviceMetadata = {
    auth: {
      allUsers: true,
    },
  };

  private chunkSize = 1048576; // Max length of data written to `FileData.data` (1mb)

  /**
   * Creates a new file record and its associated data chunks.
   * @param fileMetaData - The file metadata (name, type, size).
   * @param fileData - The file data as a string.
   * @returns The created file record.
   */
  async createFile(fileMetaData: Omit<File, keyof ScopedRecord>, fileData: string): Promise<File> {
    const db = getScopedDb();
    const file = await db.insert(tables.File, fileMetaData);
    const chunks = this.splitIntoChunks(fileData);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      await db.insert(tables.FileData, {
        file: new Reference(tables.FileData.name, file.id),
        order: index,
        data: chunk,
      });
    }

    return file;
  }

  /**
   * Splits a string into chunks of a specified size.
   * @param data - The data string to split.
   * @returns An array of data chunks.
   */
  private splitIntoChunks(data: string): string[] {
    const chunks = [];
    for (let i = 0; i < data.length; i += this.chunkSize) {
      chunks.push(data.substring(i, i + this.chunkSize));
    }
    return chunks;
  }

  /**
   * Retrieves the metadata of a given file.
   * @param fileId - The ID of the file.
   * @returns The file metadata.
   */
  async getFile(fileId: string): Promise<File> {
    const db = getScopedDb();
    const file = await db.get(tables.File, { id: fileId });
    return file;
  }

  /**
   * Retrieves the data chunks associated with a given file.
   * @param fileId - The ID of the file.
   * @returns The file data as a single string.
   */
  async getFileData(fileId: string): Promise<string> {
    const db = getScopedDb();
    const qb = new QueryBuilderFactory()
      .getQueryBuilder(tables.FileData, { file: fileId })
      .sort([{ field: 'order', desc: false }]);
    const fileDataRecords = await db.query(tables.FileData, qb);
    return fileDataRecords.map((record) => record.data).join('');
  }

  /**
   * Updates the data chunks associated with a given file.
   * @param fileId - The ID of the file.
   * @param data - The new data string to replace the existing data.
   */
  async updateFileData(fileId: string, data: string): Promise<void> {
    const db = getScopedDb();

    // Delete existing data
    const deleteQuery = new QueryBuilderFactory().getQueryBuilder(tables.FileData, { file: fileId });
    await db.delete(tables.FileData, deleteQuery);

    // Split new data into chunks and insert
    const chunks = this.splitIntoChunks(data);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      await db.insert(tables.FileData, {
        file: new Reference(tables.FileData.name, fileId),
        order: index,
        data: chunk,
      });
    }
  }

  /**
   * Updates the metadata of a given file.
   * @param file - The updated file to persist.
   */
  async updateFile(file: Omit<File, keyof ScopedRecord>): Promise<void> {
    const db = getScopedDb();
    await db.update(tables.File, file);
  }

  /**
   * Deletes a file and its data.
   * The file data is deleted by a cascade delete rule defined on the `FileTable`
   * @param fileId - The ID of the file to delete.
   */
  async deleteFile(fileId: string): Promise<void> {
    const db = getScopedDb();
    const qb = new QueryBuilderFactory().getQueryBuilder(tables.File, { id: fileId });
    await db.delete(tables.File, qb);
  }
}
