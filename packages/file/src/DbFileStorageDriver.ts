import { getScopedDb, getScopedDbAsSystem } from '@proteinjs/user';
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

  async getFileData(fileId: string): Promise<string> {
    // Byte reads are keyed by id and UNSCOPED — matching the GCS driver's semantics (a bucket
    // download by id). The driver is a byte store; access control lives with callers and the
    // scoped File METADATA layer (e.g. the /file route 404s on a foreign id before ever
    // reaching bytes). A caller-scoped read here silently returned '' for any cross-scope
    // reader a service-layer door had already authorized — an emulator/DB-driver behavior the
    // GCS deployment never had.
    const db = getScopedDbAsSystem();
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

  async deleteFile(fileId: string): Promise<void> {
    // Byte deletes are keyed by id and UNSCOPED — the same semantics as getFileData above (the
    // driver is a byte store; access control lives with callers and the scoped File metadata
    // layer), and system sweeps delete rows outside the current session's scope. Deleting zero
    // chunks succeeds, which gives this the idempotency the driver contract requires.
    const db = getScopedDbAsSystem();
    const deleteQuery = new QueryBuilderFactory().getQueryBuilder(tables.FileData, { file: fileId });
    await db.delete(tables.FileData, deleteQuery);
  }

  private splitIntoChunks(data: string): string[] {
    const chunks = [];
    for (let i = 0; i < data.length; i += this.chunkSize) {
      chunks.push(data.substring(i, i + this.chunkSize));
    }
    return chunks;
  }
}
