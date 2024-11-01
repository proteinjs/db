import { Record } from '../Record';
import { DbService, ObjectQuery } from '../services/DbService';
import { getTransactionRunner } from './TransactionRunner';
import { addDefaultFieldValues, Table } from '../Table';
import { isInstanceOf } from '@proteinjs/util';
import { QueryBuilder } from '@proteinjs/db-query';

export type OperationQueue<R extends Record = Record> = {
  insert: (...args: Parameters<DbService<R>['insert']>) => Promise<R>;
  update: (...args: Parameters<DbService<R>['update']>) => void;
  delete: (...args: Parameters<DbService<R>['delete']>) => void;
};

export type Operation<R extends Record = Record> = {
  name: 'insert' | 'update' | 'delete';
  args: Parameters<DbService<R>['insert']> | Parameters<DbService<R>['update']> | Parameters<DbService<R>['delete']>;
};

const hasAllProperties = (a: any, b: any) => Object.entries(b).every(([key, val]) => a[key] === val);

/**
 * A queue of db write operations that are executed sequentially (not batched) as a single transaction when `run` is called.
 *
 * Intended to be used on the client to decrease network calls when performing an atomic unit of db write operations.
 *
 * A more robust server-side transaction api is available via `Db.runTransaction`.
 */
export class Transaction implements OperationQueue {
  /** Operations to be run in sequence in a transaction when `run` is called. */
  ops: Operation<any>[] = [];

  /**
   * Local cache of tables.
   *
   * Data will be updated as operations are queued.
   */
  db: { [table: string]: { [id: string]: any } } = {};

  constructor(
    private onInsert?: (table: Table<any>, record: any) => void,
    private onUpdate?: (table: Table<any>, prevRecord: any, currentRecord: any) => void,
    private onDelete?: (table: Table<any>, record: any) => void
  ) {}

  /**
   * @returns locally cached records for table
   */
  recordMap(table: string) {
    if (!this.db[table]) {
      this.db[table] = {};
    }

    return this.db[table];
  }

  /**
   * Queue an insert.
   */
  async insert<R extends Record = Record>(...args: Parameters<DbService<R>['insert']>): Promise<R> {
    const [table, record] = args;
    const recordCopy = Object.assign({}, record) as R;
    await addDefaultFieldValues(table, recordCopy);
    const recordMap = this.recordMap(table.name);
    if (recordMap[recordCopy.id]) {
      throw new Error(`Attempting to insert with duplicate id: ${recordCopy.id}, record already exists`);
    }

    recordMap[recordCopy.id] = recordCopy;
    if (this.onInsert) {
      this.onInsert(table, recordCopy);
    }

    this.ops.push({ name: 'insert', args: [table, recordCopy] });

    return recordCopy;
  }

  /**
   * Queue an update.
   *
   * Updates are performed in-place on the existing object to ensure all references
   * receive the changes.
   *
   * If a `QueryBuilder` is passed in for `query`, changes will not be made to the cached `db`.
   * Passing in an `ObjectQuery` will update the cached `db`.
   */
  update<R extends Record = Record>(...args: Parameters<DbService<R>['update']>): void {
    const [table, record, query] = args;
    if (!query && !record.id) {
      throw new Error(`Update must be called with either a Query or a record with an id property`);
    }

    if (record.id) {
      const recordMap = this.recordMap(table.name);
      const existingRecord = recordMap[record.id];
      const prevRecord = { ...existingRecord };
      if (existingRecord) {
        Object.keys(record).forEach((key) => {
          if (key !== 'id') {
            existingRecord[key] = record[key as keyof R];
          }
        });
        if (this.onUpdate) {
          this.onUpdate(table, prevRecord, existingRecord);
        }
      } else {
        throw new Error(`Attempting to update record not in the cached db`);
      }
    } else if (query && !isInstanceOf(query, QueryBuilder)) {
      const objectQuery = query as ObjectQuery<any>;
      const recordMap = this.recordMap(table.name);
      if (objectQuery.id && recordMap[objectQuery.id]) {
        const existingRecord = recordMap[objectQuery.id];
        const prevRecord = { ...existingRecord };
        Object.keys(record).forEach((key) => {
          if (key !== 'id') {
            existingRecord[key] = record[key as keyof R];
          }
        });
        if (this.onUpdate) {
          this.onUpdate(table, prevRecord, existingRecord);
        }
      } else {
        for (const existingRecord of Object.values(recordMap)) {
          if (hasAllProperties(existingRecord, objectQuery)) {
            const prevRecord = { ...existingRecord };
            Object.keys(record).forEach((key) => {
              if (key !== 'id') {
                existingRecord[key] = record[key as keyof R];
              }
            });
            if (this.onUpdate) {
              this.onUpdate(table, prevRecord, existingRecord);
            }
          }
        }
      }
    }

    this.ops.push({ name: 'update', args });
  }

  /**
   * Queue a delete.
   *
   * If a `QueryBuilder` is passed in for `query`, changes will not be made to the cached `db`.
   * Passing in an `ObjectQuery` will update the cached `db`.
   */
  delete<R extends Record = Record>(...args: Parameters<DbService<R>['delete']>): void {
    const [table, query] = args;
    if (!isInstanceOf(query, QueryBuilder)) {
      const objectQuery = query as ObjectQuery<any>;
      const recordMap = this.recordMap(table.name);
      if (objectQuery.id) {
        if (this.onDelete && recordMap[objectQuery.id]) {
          this.onDelete(table, recordMap[objectQuery.id]);
        }
        delete recordMap[objectQuery.id];
      } else {
        for (const record of Object.values(recordMap)) {
          if (hasAllProperties(record, objectQuery)) {
            if (this.onDelete && recordMap[record.id]) {
              this.onDelete(table, recordMap[record.id]);
            }
            delete recordMap[record.id];
          }
        }
      }
    }

    this.ops.push({ name: 'delete', args });
  }

  /**
   * Run the operations in order (not a batch), as a single transaction.
   */
  async run(): Promise<void> {
    if (this.ops.length === 0) {
      return;
    }

    const runner = getTransactionRunner();
    await runner.run(this.ops);
    this.ops = [];
  }
}
