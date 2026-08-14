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
  PostCommitHook,
  getDefaultTransactionContextFactory,
  TransactionContextData,
} from './transaction/TransactionContextFactory';
import { isInstanceOf } from '@proteinjs/util';
import { Reference } from './reference/Reference';
import { ReferenceArray } from './reference/ReferenceArray';
import { ReferenceCache } from './reference/ReferenceCache';
import { ArrayMembershipUpdate, applyArrayMembershipOps } from './reference/ArrayMembershipOps';
import { PreservedPath, overlayPreservedPaths } from './UpdatePreserving';

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
    await this.dbDriver.runDml(generateInsert, this.transactionForDriver());
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
    // Immutable columns can never be rewritten through an update — strip them from the payload
    // (e.g. a ScopedRecord's `scope`: forced on insert; a client-path update rewriting it would
    // reassign the row into another user's scope).
    for (const columnPropertyName in table.columns) {
      const column = (table.columns as any)[columnPropertyName];
      const immutable = column?.options?.immutable;
      if (immutable === true || (typeof immutable === 'function' && immutable(this.runAsSystem))) {
        delete (recordCopy as any)[columnPropertyName];
      }
    }
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
    const recordUpdateCount = await this.dbDriver.runDml(generateUpdate, this.transactionForDriver());
    await this.tableWatcherRunner.runAfterUpdateTableWatchers(table, recordUpdateCount, recordCopy, qb);
    return recordUpdateCount;
  }

  /**
   * Apply commutative membership ops (add/remove/move) to a `ReferenceArrayColumn`
   * read-modify-write against COMMITTED truth, so concurrent membership writers
   * converge instead of last-write-wins clobbering each other (the write-side
   * lost-update class). Self-wraps in a transaction when called outside one; the
   * driver's abort/retry re-executes the read, so a retried transaction applies
   * its ops to fresh truth rather than replaying a stale list snapshot.
   *
   * Returns the update count (0 when the ops are a no-op against committed truth
   * or the record no longer exists — a concurrently deleted record wins).
   */
  async updateArrayMembership<T extends R>(table: Table<T>, update: ArrayMembershipUpdate): Promise<number> {
    if (!this.transactionContextFactory.getTransactionContext().currentTransaction) {
      const db = this.newSelfWrapDb();
      return await db.runTransaction(async () => await db.updateArrayMembership(table, update));
    }

    const column = (table.columns as any)[update.columnPropertyName];
    if (!column || column.constructor?.name !== 'ReferenceArrayColumn') {
      throw new Error(
        `updateArrayMembership requires a ReferenceArrayColumn; '${update.columnPropertyName}' on table '${table.name}' is not one`
      );
    }

    const qb = new QueryBuilderFactory().getQueryBuilder(table);
    await this.addColumnQueries(table, qb, 'write');
    qb.select({ fields: ['id', update.columnPropertyName] as any });
    qb.condition({ field: 'id', operator: '=', value: update.recordId as T[keyof T] });
    const rows = await this._query(table, qb);
    if (rows.length === 0) {
      return 0;
    }

    const currentRefArray = (rows[0] as any)[update.columnPropertyName] as ReferenceArray<any> | null | undefined;
    const currentIds = currentRefArray?._ids ?? [];
    const { ids, changed } = applyArrayMembershipOps(currentIds, update.ops);
    if (!changed) {
      return 0;
    }

    const record: Partial<T> = { id: update.recordId } as Partial<T>;
    (record as any)[update.columnPropertyName] = new ReferenceArray((column as any).referenceTable, ids);
    return await this.update(table, record);
  }

  /**
   * Update with committed-truth preservation for column sub-paths the writer does
   * not own (see `UpdatePreserving.ts`). The payload's listed paths are overlaid
   * with their committed values read inside the same transaction, so this write
   * commutes with the writers that own those paths (e.g. a structural editor op
   * writing a JSON object's styling while a debounced text save owns `content`).
   * Self-wraps in a transaction when called outside one. Plain-JSON columns only.
   */
  async updatePreserving<T extends R>(table: Table<T>, record: Partial<T>, preserve: PreservedPath[]): Promise<number> {
    if (!this.transactionContextFactory.getTransactionContext().currentTransaction) {
      const db = this.newSelfWrapDb();
      return await db.runTransaction(async () => await db.updatePreserving(table, record, preserve));
    }

    if (!record.id) {
      throw new Error(`updatePreserving must be called with a record with an id property`);
    }

    const applicable = preserve.filter((p) => (record as any)[p.columnPropertyName] !== undefined);
    if (applicable.length === 0) {
      return await this.update(table, record);
    }

    const qb = new QueryBuilderFactory().getQueryBuilder(table);
    await this.addColumnQueries(table, qb, 'write');
    qb.select({ fields: ['id', ...applicable.map((p) => p.columnPropertyName)] as any });
    qb.condition({ field: 'id', operator: '=', value: record.id as T[keyof T] });
    const rows = await this._query(table, qb);
    if (rows.length === 0) {
      return 0;
    }

    const recordCopy: Partial<T> = Object.assign({}, record);
    for (const p of applicable) {
      (recordCopy as any)[p.columnPropertyName] = overlayPreservedPaths(
        (rows[0] as any)[p.columnPropertyName],
        (recordCopy as any)[p.columnPropertyName],
        p.paths,
        p.whenType
      );
    }

    return await this.update(table, recordCopy);
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
    const recordDeleteCount = await this.dbDriver.runDml(generateDelete, this.transactionForDriver());
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

  /**
   * Run a query. Column queries (scope guards etc.) are always applied.
   *
   * PAGING: this method is also the cursor-window surface — `CursorWindowPager` composes each
   * window as a fresh QueryBuilder (cursor conditions + sort + `paginate(0, windowSize)`)
   * through here, so every window rides the caller's driver, ambient transaction, and column
   * queries. Iterating consumers go through it (`RecordIterator` server-side,
   * `QueryCursorLoader` in the UI) instead of positional `paginate(start, end)` offsets,
   * which drift under concurrent writes (rows slide across window frames).
   */
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
    const serializedRecords = await this.dbDriver.runQuery(generateQuery, this.transactionForDriver());
    const recordSerializer = new RecordSerializer(table);
    const records = await Promise.all(
      serializedRecords.map(async (serializedRecord) => recordSerializer.deserialize(serializedRecord))
    );
    await this.preloadReferences(records, options);
    return records;
  }

  /**
   * Batch-load the result set's references: one IN query per referenced table, grouped
   * across rows and reference-array members, instead of a `get()` per reference (a 30-row
   * window over references was 30 serialized point reads — each through its own default-
   * driver Db). The batch queries ride THIS instance — driver, table resolution, ambient
   * transaction, and authority — so a preload behaves like part of the query that carried
   * it. References already loaded, or serveable from `ReferenceCache` (`Reference.get`
   * consults it per read, deliberately never stamping `_object`), are left untouched.
   */
  private async preloadReferences(records: any[], queryOptions?: QueryOptions<any>) {
    const { preloadReferences } = queryOptions || {};
    if (!preloadReferences?.enabled) {
      return;
    }

    const pendingReferences: Reference<any>[] = [];
    const pendingReferenceArrays: ReferenceArray<any>[] = [];
    for (const record of records) {
      for (const [fieldPropertyName, fieldValue] of Object.entries(record)) {
        if (preloadReferences.excludeColumns?.includes(fieldPropertyName)) {
          continue;
        }

        if (preloadReferences.includeColumns && !preloadReferences.includeColumns.includes(fieldPropertyName)) {
          continue;
        }

        if (isInstanceOf(fieldValue, Reference)) {
          const reference = fieldValue as Reference<any>;
          if (!reference._object && reference._id && !ReferenceCache.get().get(reference._table, reference._id)) {
            pendingReferences.push(reference);
          }
        } else if (isInstanceOf(fieldValue, ReferenceArray)) {
          const referenceArray = fieldValue as ReferenceArray<any>;
          if (!referenceArray._objects) {
            pendingReferenceArrays.push(referenceArray);
          }
        }
      }
    }

    const idsByTable = new Map<string, Set<string>>();
    const addIds = (tableName: string, ids: string[]) => {
      if (ids.length === 0) {
        return;
      }
      let tableIds = idsByTable.get(tableName);
      if (!tableIds) {
        tableIds = new Set();
        idsByTable.set(tableName, tableIds);
      }
      for (const id of ids) {
        tableIds.add(id);
      }
    };
    for (const reference of pendingReferences) {
      addIds(reference._table, [reference._id as string]);
    }
    for (const referenceArray of pendingReferenceArrays) {
      addIds(referenceArray._table, referenceArray._ids);
    }

    const rowsByTable = new Map<string, Map<string, any>>();
    await Promise.all(
      Array.from(idsByTable.entries()).map(async ([tableName, tableIds]) => {
        const table = this.getTable(tableName);
        const qb = new QueryBuilderFactory()
          .getQueryBuilder(table)
          .condition({ field: 'id', operator: 'IN', value: Array.from(tableIds) });
        const rows = await this.query(table, qb);
        rowsByTable.set(tableName, new Map(rows.map((row) => [row.id, row])));
      })
    );

    for (const reference of pendingReferences) {
      reference._object = rowsByTable.get(reference._table)?.get(reference._id as string);
    }
    for (const referenceArray of pendingReferenceArrays) {
      const rowsById = rowsByTable.get(referenceArray._table);
      referenceArray._objects = referenceArray._ids
        .map((id) => rowsById?.get(id))
        .filter((row): row is any => row !== undefined);
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
    const result = await this.dbDriver.runQuery(generateQuery, this.transactionForDriver());
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
   * Db instances are STATELESS with respect to transactions: every operation resolves the
   * ambient transaction (AsyncLocalStorage) at call time, so any Db instance used inside the
   * transaction body — whenever it was constructed — rides the transaction. There is no way
   * to issue an operation outside a transaction from inside its body, and no second session
   * is ever acquired inside one (the historical pool-wedge class is unrepresentable —
   * plans/DB_PERF_PLAN.md P2, in the consumer repo).
   *
   * Note: Nested transactions are not supported; will throw.
   *
   * Note: work spawned inside the body but NOT awaited by it escapes the transaction's
   * lifetime while still holding its context — such work fails loudly on its next db
   * operation (see TransactionContextData.ended). Await everything inside the body, or run
   * it outside the transaction.
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
    if (this.transactionContextFactory.getTransactionContext().currentTransaction) {
      throw new Error(`Nested transactions are not supported. A transaction is already running in this context.`);
    }

    // Reassigned fresh per driver attempt: drivers may retry `fn` on transient aborts (Spanner's
    // runTransactionAsync does), and hooks queued by a discarded attempt must not survive into
    // the attempt that actually commits. Only the committed attempt's queue is drained below.
    let postCommitHooks: PostCommitHook[] = [];
    const result = await this.dbDriver.runTransaction(async (transaction) => {
      // A fresh ambient store per attempt: the transaction, the attempt's post-commit hook
      // queue (shared by every Db instance created inside — see runAfterCommit), and the
      // ended-tombstone below.
      postCommitHooks = [];
      const contextData: TransactionContextData = { currentTransaction: transaction, postCommitHooks };
      try {
        return await this.transactionContextFactory.runInContext(contextData, fn);
      } finally {
        // Tombstone the store: detached work spawned inside the body still holds it by
        // reference — the flag turns its next db operation into a loud error instead of a
        // silent op on a finished transaction (see transactionForDriver).
        contextData.ended = true;
      }
    });

    // COMMIT BOUNDARY: the driver resolves only after the transaction is durably committed (and
    // rejects on rollback, in which case the queue above is never drained). Hook failures are
    // logged, not thrown — the write already committed, and surfacing a hook error as a
    // transaction failure would report a durable write as failed.
    for (const postCommitHook of postCommitHooks) {
      try {
        await postCommitHook();
      } catch (error: any) {
        this.logger.error({ message: `Post-commit hook failed`, error });
      }
    }

    return result;
  }

  /**
   * Run `hook` once the write unit currently executing is durably committed.
   *
   * - Inside a `runTransaction` scope: the hook is queued on the ambient transaction context and
   *   runs after the transaction COMMITS. Hooks never run on rollback.
   * - Outside a transaction: every DML statement auto-commits when it resolves, so the hook runs
   *   (awaited) immediately. Callers are responsible for invoking this only from points where
   *   the triggering statement has already executed — e.g. `after*` table watchers, never
   *   `before*` ones.
   *
   * For side effects that must observe committed truth — e.g. socket notifications that trigger
   * client refetches: a pre-commit emission lets a client refetch read pre-commit rows and
   * "resurrect" state the transaction is deleting.
   */
  async runAfterCommit(hook: PostCommitHook): Promise<void> {
    const transactionContext = this.transactionContextFactory.getTransactionContext();
    if (transactionContext.currentTransaction) {
      if (!transactionContext.postCommitHooks) {
        // runTransaction is the only opener of transaction scopes and always seeds the queue —
        // an active transaction without one means a second scope owner appeared. Fail loudly
        // rather than run the hook at (wrong) pre-commit time.
        throw new Error(
          `Active transaction context has no post-commit hook queue. Transaction scopes must be opened via Db.runTransaction.`
        );
      }
      transactionContext.postCommitHooks.push(hook);
      return;
    }

    await hook();
  }

  /**
   * A fresh instance for self-wrapping RMW verbs (`updateArrayMembership`, `updatePreserving`)
   * in a transaction. `runTransaction` carries the open transaction as INSTANCE state, and these
   * verbs also serve the `DbService` RPC path, where one long-lived Db instance handles
   * concurrent requests — self-wrapping on `this` would leak one request's transaction into
   * another's ops (or spuriously reject it as a nested transaction). Same driver/tables/system
   * mode; only the transaction state is isolated.
   */
  private newSelfWrapDb(): Db<R> {
    return new Db<R>(this.dbDriver, this.getTable, this.transactionContextFactory, this.runAsSystem);
  }

  /**
   * The transaction every driver call rides, resolved from the ambient context AT CALL TIME
   * (statelessness is the safety property: operations inside a transaction body always ride
   * it; operations outside always use the pool). The one remaining failure shape — work that
   * escaped a finished transaction's body while holding its context — throws here by name;
   * handing the driver an ended transaction would fail anyway, with a far worse error.
   */
  private transactionForDriver(): any {
    const context = this.transactionContextFactory.getTransactionContext();
    if (context.ended) {
      throw new Error(
        `Db operation issued in the context of a transaction that already ended: work spawned inside a runTransaction body (and not awaited by it) survived the transaction. Await the work inside the body, or run it outside the transaction.`
      );
    }

    return context.currentTransaction;
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
