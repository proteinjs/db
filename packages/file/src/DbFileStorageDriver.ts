import { getScopedDb } from '@proteinjs/user';
import { QueryBuilderFactory, Reference } from '@proteinjs/db';
import { File } from './tables/FileTable';
import { tables } from './tables/tables';
import { FileStorageDriver } from './FileStorageDriver';

export class DbFileStorageDriver implements FileStorageDriver {
  private chunkSize = 1048576; // Max length of data written to `FileData.data` (1mb)

  /**
   * @param chunkSize the size, in bytes, to be stored in each `FileDataTable` record; default is 1mb
   */
  constructor(chunkSize?: number) {
    if (chunkSize != undefined) {
      this.chunkSize = chunkSize;
    }
  }

  async createFile(file: File, fileData: string): Promise<void> {
    const db = getScopedDb();
    const chunks = this.splitIntoChunks(fileData);
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      await db.insert(tables.FileData, {
        file: new Reference(tables.FileData.name, file.id),
        order: index,
        data: chunk,
      });
    }
  }

  private splitIntoChunks(data: string): string[] {
    const chunks = [];
    for (let i = 0; i < data.length; i += this.chunkSize) {
      chunks.push(data.substring(i, i + this.chunkSize));
    }
    return chunks;
  }

  async getFileData(fileId: string): Promise<string> {
    const db = getScopedDb();
    const qb = new QueryBuilderFactory()
      .getQueryBuilder(tables.FileData, { file: fileId })
      .sort([{ field: 'order', desc: false }]);
    const fileDataRecords = await db.query(tables.FileData, qb);
    return fileDataRecords.map((record) => record.data).join('');
  }

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
}
