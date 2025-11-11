import { Logger } from '@proteinjs/logger';
import { TableWatcherMap, getTableWatcherMap } from './TableWatcher';
import { Record } from './Record';
import { Table } from './Table';
import { QueryBuilder } from '@proteinjs/db-query';

const getEnvVar = (key: string): string | undefined =>
  typeof process !== 'undefined' && process.env ? process.env[key] : undefined;

export class TableWatcherRunner<R extends Record = Record> {
  private static tableWatcherMap: TableWatcherMap;
  private logger = new Logger({ name: this.constructor.name, logLevel: getEnvVar('DB_LOG_LEVEL') as any });

  constructor() {
    if (!TableWatcherRunner.tableWatcherMap) {
      TableWatcherRunner.tableWatcherMap = getTableWatcherMap();
    }
  }

  async runBeforeInsertTableWatchers<T extends R>(
    table: Table<T>,
    record: Omit<T, keyof R>
  ): Promise<Omit<T, keyof R>> {
    const tableWatcherMap = TableWatcherRunner.tableWatcherMap[table.name];
    if (!tableWatcherMap) {
      return record;
    }

    const tableWatchers = tableWatcherMap.beforeInsert;
    if (tableWatchers.length === 0) {
      return record;
    }

    this.logger.info({ message: `(${table.name}) Running before-insert table watchers` });
    let updatedRecord: any = record;
    for (const tableWatcher of tableWatchers) {
      this.logger.info({ message: `(${table.name}) Running ${tableWatcher.name()}.beforeInsert` });
      updatedRecord = await tableWatcher.beforeInsert(updatedRecord);
      this.logger.info({ message: `(${table.name}) Finished running ${tableWatcher.name()}.beforeInsert` });
    }
    this.logger.info({ message: `(${table.name}) Finished running before-insert table watchers` });

    return updatedRecord;
  }

  async runAfterInsertTableWatchers<T extends R>(table: Table<T>, record: T): Promise<void> {
    const tableWatcherMap = TableWatcherRunner.tableWatcherMap[table.name];
    if (!tableWatcherMap) {
      return;
    }

    const tableWatchers = tableWatcherMap.afterInsert;
    if (tableWatchers.length === 0) {
      return;
    }

    this.logger.info({ message: `(${table.name}) Running after-insert table watchers` });
    for (const tableWatcher of tableWatchers) {
      this.logger.info({ message: `(${table.name}) Running ${tableWatcher.name()}.afterInsert` });
      await tableWatcher.afterInsert(record);
      this.logger.info({ message: `(${table.name}) Finished running ${tableWatcher.name()}.afterInsert` });
    }
    this.logger.info({ message: `(${table.name}) Finished running after-insert table watchers` });
  }

  async runBeforeUpdateTableWatchers<T extends R>(
    table: Table<T>,
    record: Partial<T>,
    qb: QueryBuilder<T>
  ): Promise<Partial<T>> {
    const tableWatcherMap = TableWatcherRunner.tableWatcherMap[table.name];
    if (!tableWatcherMap) {
      return record;
    }

    const tableWatchers = tableWatcherMap.beforeUpdate;
    if (tableWatchers.length === 0) {
      return record;
    }

    this.logger.info({ message: `(${table.name}) Running before-update table watchers` });
    const qbCopy = QueryBuilder.fromQueryBuilder(qb, table.name);
    let updatedRecord: any = record;
    for (const tableWatcher of tableWatchers) {
      this.logger.info({ message: `(${table.name}) Running ${tableWatcher.name()}.beforeUpdate` });
      updatedRecord = await tableWatcher.beforeUpdate(updatedRecord, qbCopy);
      this.logger.info({ message: `(${table.name}) Finished running ${tableWatcher.name()}.beforeUpdate` });
    }
    this.logger.info({ message: `(${table.name}) Finished running before-update table watchers` });

    return updatedRecord;
  }

  async runAfterUpdateTableWatchers<T extends R>(
    table: Table<T>,
    recordUpdateCount: number,
    record: Partial<T>,
    qb: QueryBuilder<T>
  ): Promise<void> {
    const tableWatcherMap = TableWatcherRunner.tableWatcherMap[table.name];
    if (!tableWatcherMap) {
      return;
    }

    const tableWatchers = tableWatcherMap.afterUpdate;
    if (tableWatchers.length === 0) {
      return;
    }

    this.logger.info({ message: `(${table.name}) Running after-update table watchers` });
    const qbCopy = QueryBuilder.fromQueryBuilder(qb, table.name);
    for (const tableWatcher of tableWatchers) {
      this.logger.info({ message: `(${table.name}) Running ${tableWatcher.name()}.afterUpdate` });
      await tableWatcher.afterUpdate(recordUpdateCount, record, qbCopy);
      this.logger.info({ message: `(${table.name}) Finished running ${tableWatcher.name()}.afterUpdate` });
    }
    this.logger.info({ message: `(${table.name}) Finished running after-update table watchers` });
  }

  async runBeforeDeleteTableWatchers<T extends R>(
    table: Table<T>,
    recordsToDelete: T[],
    initialQb: QueryBuilder<T>,
    deleteQb: QueryBuilder<T>
  ): Promise<void> {
    const tableWatcherMap = TableWatcherRunner.tableWatcherMap[table.name];
    if (!tableWatcherMap) {
      return;
    }

    const tableWatchers = tableWatcherMap.beforeDelete;
    if (tableWatchers.length === 0) {
      return;
    }

    this.logger.info({ message: `(${table.name}) Running before-delete table watchers` });
    const initialQbCopy = QueryBuilder.fromQueryBuilder(initialQb, table.name);
    for (const tableWatcher of tableWatchers) {
      this.logger.info({ message: `(${table.name}) Running ${tableWatcher.name()}.beforeDelete` });
      await tableWatcher.beforeDelete(recordsToDelete, initialQbCopy, deleteQb);
      this.logger.info({ message: `(${table.name}) Finished running ${tableWatcher.name()}.beforeDelete` });
    }
    this.logger.info({ message: `(${table.name}) Finished running before-delete table watchers` });
  }

  async runAfterDeleteTableWatchers<T extends R>(
    table: Table<T>,
    recordDeleteCount: number,
    deletedRecords: T[],
    initialQb: QueryBuilder<T>,
    deleteQb: QueryBuilder<T>
  ): Promise<void> {
    const tableWatcherMap = TableWatcherRunner.tableWatcherMap[table.name];
    if (!tableWatcherMap) {
      return;
    }

    const tableWatchers = tableWatcherMap.afterDelete;
    if (tableWatchers.length === 0) {
      return;
    }

    this.logger.info({ message: `(${table.name}) Running after-delete table watchers` });
    const initialQbCopy = QueryBuilder.fromQueryBuilder(initialQb, table.name);
    for (const tableWatcher of tableWatchers) {
      this.logger.info({ message: `(${table.name}) Running ${tableWatcher.name()}.afterDelete` });
      await tableWatcher.afterDelete(recordDeleteCount, deletedRecords, initialQbCopy, deleteQb);
      this.logger.info({ message: `(${table.name}) Finished running ${tableWatcher.name()}.afterDelete` });
    }
    this.logger.info({ message: `(${table.name}) Finished running after-delete table watchers` });
  }
}
