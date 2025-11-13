import { DbService, Query, QueryOptions, getDbService } from './services/DbService';
import { Service } from '@proteinjs/service';
import { Loadable, SourceRepository } from '@proteinjs/reflection';
import {
  Column,
  Table,
  getColumnPropertyName,
  tableByName,
  addDefaultFieldValues,
  addUpdateFieldValues,
  getTables,
} from './Table';
import { Record, RecordSerializer, SerializedRecord } from './Record';
import { Logger } from '@proteinjs/logger';
import { SourceRecordLoader } from './source/SourceRecordLoader';
import { ParameterizationConfig, QueryBuilder, Statement, StatementFactory } from '@proteinjs/db-query';
import { QueryBuilderFactory } from './QueryBuilderFactory';
import { StatementConfigFactory } from './StatementConfigFactory';
import { TableManager } from './schema/TableManager';
import { TableAuth } from './auth/TableAuth';
import { TableServiceAuth } from './auth/TableServiceAuth';
import { TableWatcherRunner } from './TableWatcherRunner';
import {
  DefaultTransactionContextFactory,
  getDefaultTransactionContextFactory,
} from './transaction/TransactionContextFactory';
import { isInstanceOf } from '@proteinjs/util';
import { Reference } from './reference/Reference';
import { ReferenceArray } from './reference/ReferenceArray';

/** get `Db` if on server, and `DbService` if on browser */
export const getDb = <R extends Record = Record>() =>
  typeof self === 'undefined' ? new Db<R>() : (getDbService() as Db<R>);
export const getDbAsSystem = <R extends Record = Record>() => new Db<R>(undefined, undefined, undefined, true);

const getEnvVar = (key: string): string | undefined =>
  typeof process !== 'undefined' && process.env ? process.env[key] : undefined;

export type DbDriverQueryStatementConfig = ParameterizationConfig & {
  prefixTablesWithDb?: boolean;
  getDriverColumnType?: (tableName: string, columnName: string) => string;
  handleCaseSensitivity: (tableName: string, columnName: string, caseSensitive: boolean) => string;
};

export type DbDriverDmlStatementConfig = ParameterizationConfig & {
  prefixTablesWithDb?: boolean;
  getDriverColumnType?: (tableName: string, columnName: string) => string;
};

export interface DefaultDbDriverFactory extends Loadable {
  getDbDriver(): DbDriver;
}

export interface DbDriver {
  getDbName(): string;
  createDbIfNotExists(): Promise<void>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  getTableManager(): TableManager;
  runQuery(
    generateStatement: (config: DbDriverQueryStatementConfig) => Statement,
    transaction?: any
  ): Promise<SerializedRecord[]>;
  runDml(generateStatement: (config: DbDriverDmlStatementConfig) => Statement, transaction?: any): Promise<number>;
  runTransaction<T>(fn: (transaction: any) => Promise<T>): Promise<T>;
}

export class Db<R extends Record = Record> implements DbService<R> {
  private static defaultDbDriver: DbDriver;
  private dbDriver: DbDriver;
  private getTable: (tableName: string) => Table<any>;
  private logger = new Logger({ name: this.constructor.name, logLevel: getEnvVar('DB_LOG_LEVEL') as any });
  private statementConfigFactory: StatementConfigFactory;
  private auth = new TableAuth();
  private tableWatcherRunner = new TableWatcherRunner<R>();
  private currentTransaction?: any;
  private transactionContextFactory: DefaultTransactionContextFactory;
  public serviceMetadata: Service['serviceMetadata'] = {
    auth: {
      canAccess: (methodName, args) => new TableServiceAuth().canAccess(methodName, args),
    },
  };

  constructor(
    dbDriver?: DbDriver,
    getTable?: (tableName: string) => Table<any>,
    transactionContextFactory?: DefaultTransactionContextFactory,
    private runAsSystem: boolean = false
  ) {
    this.dbDriver = dbDriver ? dbDriver : Db.getDefaultDbDriver();
    this.getTable = getTable ?? tableByName;
    this.statementConfigFactory = new StatementConfigFactory(this.dbDriver.getDbName(), getTable);
    this.transactionContextFactory = transactionContextFactory
      ? transactionContextFactory
      : this.getDefaultTransactionContextFactory();
    const transactionContext = this.transactionContextFactory.getTransactionContext();
    if (transactionContext.currentTransaction) {
      this.currentTransaction = transactionContext.currentTransaction;
    }
  }

  static getDefaultDbDriver(): DbDriver {
    if (!Db.defaultDbDriver) {
      const defaultDbDriverFactory = SourceRepository.get().object<DefaultDbDriverFactory>(
        '@proteinjs/db/DefaultDbDriverFactory'
      );
      if (!defaultDbDriverFactory) {
        throw new Error(
          `Unable to find a @proteinjs/db/DefaultDbDriverFactory implementation. Either implement DefaultDbDriverFactory or pass in a db driver when instantiating Db.`
        );
      }

      Db.defaultDbDriver = defaultDbDriverFactory.getDbDriver();
    }

    return Db.defaultDbDriver;
  }

  private getDefaultTransactionContextFactory(): DefaultTransactionContextFactory {
    const defaultTransactionContextFactory = getDefaultTransactionContextFactory();
    if (!defaultTransactionContextFactory) {
      throw new Error(`Unable to find a @proteinjs/db/DefaultTransactionContextFactory implementation.`);
    }

    return defaultTransactionContextFactory;
  }

  async init(): Promise<void> {
    await this.dbDriver.createDbIfNotExists();
    await this.dbDriver.getTableManager().loadTables();
    await new SourceRecordLoader().load();
  }

  async tableExists<T extends R>(table: Table<T>): Promise<boolean> {
    return await this.dbDriver.getTableManager().tableExists(table);
  }

  async get<T extends R>(table: Table<T>, query: Query<T>, options?: QueryOptions<T>): Promise<T> {
    return (await this.query(table, query, options))[0];
  }

  async insert<T extends R>(table: Table<T>, record: Omit<T, keyof R>): Promise<T> {
    if (!this.runAsSystem) {
      this.auth.canInsert(table);
    }

    let recordCopy = Object.assign({}, record);
    await addDefaultFieldValues(table, recordCopy, this.runAsSystem);
    recordCopy = await this.tableWatcherRunner.runBeforeInsertTableWatchers(table, recordCopy);
    await this.addColumnInsertHooks(table, recordCopy);
    const recordSerializer = new RecordSerializer(table);
    const serializedRecord = await recordSerializer.serialize(recordCopy);
    const generateInsert = (config: DbDriverDmlStatementConfig) =>
      new StatementFactory<T>().insert(
        table.name,
        serializedRecord as Partial<T>,
        this.statementConfigFactory.getStatementConfig(config)
      );
    await this.dbDriver.runDml(generateInsert, this.currentTransaction);
    await this.tableWatcherRunner.runAfterInsertTableWatchers(table, recordCopy as T);
    return recordCopy as T;
  }

  async update<T extends R>(table: Table<T>, record: Partial<T>, query?: Query<T>): Promise<number> {
    if (!this.runAsSystem) {
      this.auth.canUpdate(table);
    }

    if (!query && !record.id) {
      throw new Error(`Update must be called with either a Query or a record with an id property`);
    }

    let recordCopy = Object.assign({}, record);
    await addUpdateFieldValues(table, recordCopy);
    const qb = new QueryBuilderFactory().getQueryBuilder(table, query);
    await this.addColumnQueries(table, qb, 'write');
    if (!query) {
      qb.condition({ field: 'id', operator: '=', value: recordCopy.id as T[keyof T] });
    }

    recordCopy = await this.tableWatcherRunner.runBeforeUpdateTableWatchers(table, recordCopy, qb);
    const recordSerializer = new RecordSerializer<T>(table);
    const serializedRecord = await recordSerializer.serialize(recordCopy);
    delete serializedRecord['id'];
    const generateUpdate = (config: DbDriverDmlStatementConfig) =>
      new StatementFactory<T>().update(
        table.name,
        serializedRecord as Partial<T>,
        qb,
        this.statementConfigFactory.getStatementConfig(config)
      );
    const recordUpdateCount = await this.dbDriver.runDml(generateUpdate, this.currentTransaction);
    await this.tableWatcherRunner.runAfterUpdateTableWatchers(table, recordUpdateCount, recordCopy, qb);
    return recordUpdateCount;
  }

  async delete<T extends R>(table: Table<T>, query: Query<T>): Promise<number> {
    if (!this.runAsSystem) {
      this.auth.canDelete(table);
    }

    const qb = new QueryBuilderFactory().getQueryBuilder(table, query);
    await this.addColumnQueries(table, qb, 'delete');
    const recordsToDelete = await this._query(table, qb);
    if (recordsToDelete.length == 0) {
      return 0;
    }

    const recordsToDeleteIds = recordsToDelete.map((record) => record.id);
    const deleteQb = new QueryBuilderFactory().getQueryBuilder(table);
    deleteQb.condition({ field: 'id', operator: 'IN', value: recordsToDeleteIds as T[keyof T][] });
    const generateDelete = (config: DbDriverDmlStatementConfig) =>
      new StatementFactory<T>().delete(table.name, deleteQb, this.statementConfigFactory.getStatementConfig(config));
    await this.runColumnBeforeDeletes(table, recordsToDelete);
    await this.tableWatcherRunner.runBeforeDeleteTableWatchers(table, recordsToDelete, qb, deleteQb);
    const recordDeleteCount = await this.dbDriver.runDml(generateDelete, this.currentTransaction);
    await this.runCascadeDeletions(table, recordsToDelete);
    await this.runColumnReverseCascadeDeletions(table, recordsToDelete);
    await this.tableWatcherRunner.runAfterDeleteTableWatchers(table, recordDeleteCount, recordsToDelete, qb, deleteQb);
    return recordDeleteCount;
  }

  private async runColumnBeforeDeletes(table: Table<any>, recordsToDelete: Record[]) {
    for (const columnPropertyName in table.columns) {
      const column = (table.columns as any)[columnPropertyName] as Column<any, any>;
      if (typeof column.beforeDelete !== 'undefined') {
        await column.beforeDelete(
          table,
          columnPropertyName,
          recordsToDelete,
          this.getTable,
          new Db(this.dbDriver, this.getTable, this.transactionContextFactory)
        );
      }
    }
  }

  private async runCascadeDeletions(table: Table<any>, deletedRecords: Record[]) {
    const deletedRecordIds = deletedRecords.map((record) => record.id);
    if (deletedRecordIds.length < 1) {
      return;
    }

    if (table.cascadeDeleteReferences().length < 1) {
      return;
    }

    for (const cascadeDeleteReference of table.cascadeDeleteReferences()) {
      const referenceTable = this.getTable(cascadeDeleteReference.table);
      const referenceColumnPropertyName = getColumnPropertyName(referenceTable, cascadeDeleteReference.referenceColumn);
      this.logger.info({
        message: `Executing cascade delete for table: ${table.name}`,
        obj: {
          table: table.name,
          referenceTable: referenceTable.name,
          referenceColumnPropertyName,
          deletedRecordIds,
        },
      });
      const cascadeDeleteQb = new QueryBuilderFactory().getQueryBuilder(referenceTable);
      cascadeDeleteQb.condition({
        field: referenceColumnPropertyName as string,
        operator: 'IN',
        value: deletedRecordIds,
      });
      const deleteCount = await this.delete(referenceTable, cascadeDeleteQb);
      this.logger.info({
        message: `Cascade deleted ${deleteCount} record${deleteCount == 1 ? '' : 's'}`,
      });
    }
  }

  /**
   * Reverse cascades driven by column-level flags on reference columns only.
   * Supports:
   *  - ReferenceColumn
   *  - DynamicReferenceColumn
   *  - ReferenceArrayColumn (stringified JSON) via LIKE-prefilter + exact check
   */
  private async runColumnReverseCascadeDeletions(table: Table<any>, deletedRecords: Record[]): Promise<void> {
    const deletedIds = deletedRecords.map((r) => r.id);
    if (deletedIds.length === 0) {
      return;
    }

    const deletedIdSet = new Set<string>(deletedIds);
    const allTables = getTables();

    for (const referencingTable of allTables) {
      for (const colPropName in referencingTable.columns) {
        const col = referencingTable.columns[colPropName] as any;

        // Only act if the column explicitly opted in
        if (!col || col.reverseCascadeDelete !== true) {
          continue;
        }

        // DynamicReferenceColumn: has dynamicRefTableColName
        if (typeof col.dynamicRefTableColName === 'string' && col.dynamicRefTableColName.length > 0) {
          const dynTableProp = getColumnPropertyName(referencingTable, col.dynamicRefTableColName);
          if (!dynTableProp) {
            continue;
          }

          const qb = new QueryBuilderFactory().getQueryBuilder(referencingTable);
          await this.addColumnQueries(referencingTable, qb, 'read');

          qb.condition({ field: dynTableProp as any, operator: '=', value: table.name as any });
          qb.condition({ field: colPropName as any, operator: 'IN', value: deletedIds as any });

          this.logger.info({
            message: `Executing reverse cascade (dynamic) for table: ${table.name}`,
            obj: { referencingTable: referencingTable.name, columnPropertyName: colPropName, deletedIds },
          });

          const deleteCount = await this.delete(referencingTable, qb);
          this.logger.info({
            message: `Reverse cascade (dynamic) deleted ${deleteCount} record${deleteCount == 1 ? '' : 's'}`,
          });
          continue;
        }

        // ReferenceColumn/ReferenceArrayColumn must match the target table
        if (col.referenceTable !== table.name) {
          continue;
        }

        const ctorName = col.constructor?.name;

        if (ctorName === 'ReferenceColumn') {
          const qb = new QueryBuilderFactory().getQueryBuilder(referencingTable);
          await this.addColumnQueries(referencingTable, qb, 'read');
          qb.condition({ field: colPropName as any, operator: 'IN', value: deletedIds as any });

          this.logger.info({
            message: `Executing reverse cascade (ReferenceColumn) for table: ${table.name}`,
            obj: { referencingTable: referencingTable.name, columnPropertyName: colPropName, deletedIds },
          });

          const deleteCount = await this.delete(referencingTable, qb);
          this.logger.info({
            message: `Reverse cascade (ReferenceColumn) deleted ${deleteCount} record${deleteCount == 1 ? '' : 's'}`,
          });
        } else if (ctorName === 'ReferenceArrayColumn') {
          await this.reverseDeleteReferenceArrayHolders(referencingTable, colPropName, deletedIds, deletedIdSet);
        } else {
          continue;
        }
      }
    }
  }

  /**
   * Reverse cascade for ReferenceArrayColumn that stores stringified JSON array of IDs.
   * Strategy:
   *  1) LIKE prefilter with %"<id>"% in chunks
   *  2) Exact check in memory via deserialized ReferenceArray._ids
   *  3) Delete by primary key in chunks
   */
  private async reverseDeleteReferenceArrayHolders(
    referencingTable: Table<any>,
    columnPropertyName: string,
    deletedIds: string[],
    deletedIdSet: Set<string>
  ): Promise<void> {
    const likeChunkSize = 100;
    const deleteChunkSize = 1000;

    this.logger.info({
      message: `Executing reverse cascade (ReferenceArrayColumn) for table`,
      obj: { referencingTable: referencingTable.name, columnPropertyName, deletedIdsCount: deletedIds.length },
    });

    for (const idsChunk of this.chunk(deletedIds, likeChunkSize)) {
      const qb = new QueryBuilderFactory().getQueryBuilder(referencingTable);
      await this.addColumnQueries(referencingTable, qb, 'read');

      qb.select({ fields: ['id', columnPropertyName] });
      qb.and([{ field: columnPropertyName, operator: 'IS NOT NULL' }]);

      const likeConds = idsChunk.map((id) => {
        const escaped = String(id).replace(/"/g, '\\"');
        return { field: columnPropertyName, operator: 'LIKE' as const, value: `%"${escaped}"%` };
      });
      qb.or(likeConds);

      const candidates = await this._query(referencingTable, qb);

      const holderIdsToDelete: string[] = [];
      for (const rec of candidates) {
        const refArr = rec[columnPropertyName] as ReferenceArray<Record> | null | undefined;
        const ids = (refArr && (refArr as any)._ids ? (refArr as any)._ids : []) as string[];
        if (!ids?.length) {
          continue;
        }
        if (ids.some((x) => deletedIdSet.has(x))) {
          holderIdsToDelete.push(rec.id);
        }
      }

      if (holderIdsToDelete.length === 0) {
        continue;
      }

      const uniqueIds = Array.from(new Set(holderIdsToDelete));
      for (const delChunk of this.chunk(uniqueIds, deleteChunkSize)) {
        const delQb = new QueryBuilderFactory()
          .getQueryBuilder(referencingTable)
          .condition({ field: 'id', operator: 'IN', value: delChunk });

        const deleteCount = await this.delete(referencingTable, delQb);
        this.logger.info({
          message: `Reverse cascade (ReferenceArrayColumn) deleted ${deleteCount} record${deleteCount == 1 ? '' : 's'}`,
          obj: { referencingTable: referencingTable.name, columnPropertyName, batchSize: delChunk.length },
        });
      }
    }
  }

  async query<T extends R>(table: Table<T>, query: Query<T>, options?: QueryOptions<T>): Promise<T[]> {
    const qb = new QueryBuilderFactory().getQueryBuilder(table, query);

    // Public query interface always runs column queries
    await this.addColumnQueries(table, qb);

    return this._query(table, qb, options);
  }

  private async _query<T extends R>(table: Table<T>, qb: QueryBuilder, options?: QueryOptions<T>): Promise<T[]> {
    if (!this.runAsSystem) {
      this.auth.canQuery(table);
    }

    const generateQuery = (config: DbDriverQueryStatementConfig) =>
      qb.toSql(this.statementConfigFactory.getStatementConfig(config));
    const serializedRecords = await this.dbDriver.runQuery(generateQuery, this.currentTransaction);
    const recordSerializer = new RecordSerializer(table);
    const records = await Promise.all(
      serializedRecords.map(async (serializedRecord) => recordSerializer.deserialize(serializedRecord))
    );
    await this.preloadReferences(records, options);
    return records;
  }

  private async preloadReferences(records: any[], queryOptions?: QueryOptions<any>) {
    const { preloadReferences } = queryOptions || {};
    if (!preloadReferences?.enabled) {
      return;
    }

    for (const record of records) {
      const fields = Object.entries(record);
      for (const [fieldPropertyName, fieldValue] of fields) {
        if (preloadReferences.excludeColumns?.includes(fieldPropertyName)) {
          continue;
        }

        if (preloadReferences.includeColumns && !preloadReferences.includeColumns.includes(fieldPropertyName)) {
          continue;
        }

        if (isInstanceOf(fieldValue, Reference) || isInstanceOf(fieldValue, ReferenceArray)) {
          await (fieldValue as Reference<any> | ReferenceArray<any>).get();
        }
      }
    }
  }

  async getRowCount<T extends R>(table: Table<T>, query?: Query<T>): Promise<number> {
    if (!this.runAsSystem) {
      this.auth.canQuery(table);
    }

    const qb = new QueryBuilderFactory().getQueryBuilder(table, query);
    qb.aggregate({ function: 'COUNT', resultProp: 'count' });
    await this.addColumnQueries(table, qb);
    const generateQuery = (config: DbDriverQueryStatementConfig) =>
      qb.toSql(this.statementConfigFactory.getStatementConfig(config));
    const result = await this.dbDriver.runQuery(generateQuery, this.currentTransaction);
    return result[0]['count'];
  }

  private async addColumnQueries<T extends R>(
    table: Table<T>,
    qb: QueryBuilder<T>,
    operation: 'read' | 'write' | 'delete' = 'read'
  ) {
    for (const columnPropertyName in table.columns) {
      const column = (table.columns as any)[columnPropertyName] as Column<any, any>;
      if (column.options?.addToQuery) {
        await column.options.addToQuery(qb, this.runAsSystem, operation);
      }
    }
  }

  private async addColumnInsertHooks(table: Table<any>, record: any) {
    for (const columnPropertyName in table.columns) {
      const column = (table.columns as any)[columnPropertyName] as Column<any, any>;
      if (column.options?.onBeforeInsert) {
        await column.options.onBeforeInsert(record, this.runAsSystem);
      }
    }
  }

  /**
   * Run a transaction.
   *
   * Use this db instance for any operation you want to include in the transaction.
   *
   * Note: This method uses Db instance state. Usually it is best to create a new instance
   * of Db to run a transaction.
   *
   * Note: Nested transactions are not supported; will throw.
   *
   *
   * Example:
   *
   * ```
   * const db = getDb();
   * const results = await db.runTransaction(async () => {
   *   const emp1 = await db.insert(emplyeeTable, testEmployee1);
   *   const emp2 = await db.insert(emplyeeTable, testEmployee2);
   *   await db.update(emplyeeTable, { department: 'R&D' }, { id: emp1.id });
   *   await someFunctionThatDoesDbOps(db);
   *   return { emp1, emp2 };
   * });
   * ```
   */
  async runTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.currentTransaction) {
      throw new Error(`Nested transactions are not supported. A transaction is already running on this Db instance.`);
    }

    return await this.dbDriver.runTransaction(async (transaction) => {
      this.currentTransaction = transaction;

      try {
        return await this.transactionContextFactory.runInContext(transaction, async () => {
          const result = await fn();
          return result;
        });
      } finally {
        this.currentTransaction = undefined;
      }
    });
  }

  // Utility: simple chunker
  private chunk<T>(arr: T[], size: number): T[][] {
    if (size <= 0) {
      return [arr];
    }
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      out.push(arr.slice(i, i + size));
    }
    return out;
  }
}
