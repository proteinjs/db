import { ScopedRecord, getScopedDb } from '@proteinjs/user';
import { QueryBuilder } from '@proteinjs/db-query';
import { QueryBuilderFactory, Reference } from '@proteinjs/db';
import { File } from './tables/FileTable';
import { tables } from './tables/tables';
import { DbFileService, getDbFileService } from './services/DbFileService';

export const getDbFile = () => (typeof self === 'undefined' ? new DbFile() : (getDbFileService() as DbFile));

export class DbFile implements DbFileService {
  public serviceMetadata = {
    auth: {
      allUsers: true,
    },
  };
  
  /**
   * Creates a new file record and its associated data chunks.
   * @param fileMetaData - The file metadata (name, type, size).
   * @param fileData - An array of data chunks to be associated with the file.
   * @returns The created file record.
   */
  async createFile(fileMetaData: Omit<File, keyof ScopedRecord>, fileData: string[]): Promise<File> {
    const db = getScopedDb();
    const file = await db.insert(tables.File, fileMetaData);

    for (let index = 0; index < fileData.length; index++) {
      const chunk = fileData[index];
      await db.insert(tables.FileData, {
        file: new Reference(tables.FileData.name, file.id),
        order: index,
        data: chunk,
      });
    }

    return file;
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
   * @returns An array of data chunks.
   */
  async getFileData(fileId: string): Promise<string[]> {
    const db = getScopedDb();
    const qb = new QueryBuilderFactory().getQueryBuilder(tables.FileData, { file: fileId }).sort([{ field: 'order', desc: false }]);
    const fileDataRecords = await db.query(tables.FileData, qb);
    return fileDataRecords.map((record) => record.data);
  }

  /**
   * Updates the data chunks associated with a given file.
   * @param fileId - The ID of the file.
   * @param data - An array of new data chunks to replace the existing ones.
   */
  async updateFileData(fileId: string, data: string[]): Promise<void> {
    const db = getScopedDb();

    // Delete existing data
    const deleteQuery = new QueryBuilder(tables.FileData.name).condition({ field: 'file', operator: '=', value: fileId });
    await db.delete(tables.FileData, deleteQuery);

    // Insert new data
    for (let index = 0; index < data.length; index++) {
      const chunk = data[index];
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