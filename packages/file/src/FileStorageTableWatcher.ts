import { QueryBuilder, Table, TableWatcher } from '@proteinjs/db';
import { Logger } from '@proteinjs/logger';
import { File, FileTable } from './tables/FileTable';
import { FileStorage } from './FileStorage';

/**
 * Deletes stored file bytes whenever file rows are deleted. Lives at the Db layer so every
 * delete path reaches the byte store — `FileStorage.deleteFile`, reference cascades (e.g.
 * `file.preview`), and system sweeps that delete file rows directly.
 *
 * Bytes go first (`beforeDelete`): if the byte delete fails, the row survives to drive a retry;
 * the reverse order would strand bytes with no row left to retry from. A retried delete is safe
 * because `FileStorageDriver.deleteFile` is idempotent on the goal state.
 */
export class FileStorageTableWatcher implements TableWatcher<File> {
  private logger = new Logger({ name: this.constructor.name });

  name(): string {
    return this.constructor.name;
  }

  table(): Table<File> {
    return new FileTable();
  }

  async beforeDelete<T extends File>(
    recordsToDelete: T[],
    initialQb: QueryBuilder<T>,
    deleteQb: QueryBuilder<T>
  ): Promise<void> {
    const driver = FileStorage.getDriver();
    const deletedFileIds: string[] = [];
    for (const record of recordsToDelete) {
      await driver.deleteFile(record.id);
      deletedFileIds.push(record.id);
    }

    this.logger.info({
      message: `Deleted stored bytes for file records being deleted`,
      obj: { deletedFileIds },
    });
  }
}
