import { DbService, Query, getDbService } from './services/DbService';
import { Service } from '@proteinjs/service';
import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { Column, Table, getColumnPropertyName, tableByName } from './Table';
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

export const getDb = <R extends Record = Record>() =>
  typeof self === 'undefined' ? new Db<R>() : (getDbService() as Db<R>);
export const getDbAsSystem = <R extends Record = Record>() => new Db<R>(undefined, undefined, true);

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
  runQuery(generateStatement: (config: DbDriverQueryStatementConfig) => Statement): Promise<SerializedRecord[]>;
  runDml(generateStatement: (config: DbDriverDmlStatementConfig) => Statement): Promise<number>; // returns the number of affected rows
}

export class Db<R extends Record = Record> implements DbService<R> {
  private static defaultDbDriver: DbDriver;
  private dbDriver: DbDriver;
  private logger = new Logger({ name: this.constructor.name });
  private statementConfigFactory: StatementConfigFactory;
  private auth = new TableAuth();
  private tableWatcherRunner = new TableWatcherRunner<R>();
  public serviceMetadata: Service['serviceMetadata'] = {
    auth: {
      canAccess: (methodName, args) => new TableServiceAuth().canAccess(methodName, args),
    },
  };

  constructor(
    dbDriver?: DbDriver,
    getTable?: (tableName: string) => Table<any>,
    private runAsSystem: boolean = false
  ) {
    this.dbDriver = dbDriver ? dbDriver : this.getDefaultDbDriver();
    this.statementConfigFactory = new StatementConfigFactory(this.dbDriver.getDbName(), getTable);
  }

  private getDefaultDbDriver(): DbDriver {
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

  async init(): Promise<void> {
    await this.dbDriver.createDbIfNotExists();
    await this.dbDriver.getTableManager().loadTables();
    await new SourceRecordLoader().load();
  }

  async tableExists<T extends R>(table: Table<T>): Promise<boolean> {
    return await this.dbDriver.getTableManager().tableExists(table);
  }

  async get<T extends R>(table: Table<T>, query: Query<T>): Promise<T> {
    return (await this.query(table, query))[0];
  }

  async insert<T extends R>(table: Table<T>, record: Omit<T, keyof R>): Promise<T> {
    if (!this.runAsSystem) {
      this.auth.canInsert(table);
    }

    let recordCopy = Object.assign({}, record);
    await this.addDefaultFieldValues(table, recordCopy);
    recordCopy = await this.tableWatcherRunner.runBeforeInsertTableWatchers(table, recordCopy);
    const recordSearializer = new RecordSerializer(table);
    const serializedRecord = await recordSearializer.serialize(recordCopy);
    const generateInsert = (config: DbDriverDmlStatementConfig) =>
      new StatementFactory<T>().insert(
        table.name,
        serializedRecord as Partial<T>,
        this.statementConfigFactory.getStatementConfig(config)
      );
    await this.dbDriver.runDml(generateInsert);
    await this.tableWatcherRunner.runAfterInsertTableWatchers(table, recordCopy as T);
    return recordCopy as T;
  }

  private async addDefaultFieldValues<T extends R>(table: Table<T>, record: any) {
    for (const columnPropertyName in table.columns) {
      const column = (table.columns as any)[columnPropertyName] as Column<any, any>;
      if (column.options?.defaultValue && typeof record[columnPropertyName] === 'undefined') {
        record[columnPropertyName] = await column.options.defaultValue(record);
      }
    }
  }

  async update<T extends R>(table: Table<T>, record: Partial<T>, query?: Query<T>): Promise<number> {
    if (!this.runAsSystem) {
      this.auth.canUpdate(table);
    }

    if (!query && !record.id) {
      throw new Error(`Update must be called with either a Query or a record with an id property`);
    }

    let recordCopy = Object.assign({}, record);
    await this.addUpdateFieldValues(table, recordCopy);
    const qb = new QueryBuilderFactory().getQueryBuilder(table, query);
    this.addColumnQueries(table, qb);
    if (!query) {
      qb.condition({ field: 'id', operator: '=', value: recordCopy.id as T[keyof T] });
    }

    recordCopy = await this.tableWatcherRunner.runBeforeUpdateTableWatchers(table, recordCopy, qb);
    const recordSearializer = new RecordSerializer<T>(table);
    const serializedRecord = await recordSearializer.serialize(recordCopy);
    delete serializedRecord['id'];
    const generateUpdate = (config: DbDriverDmlStatementConfig) =>
      new StatementFactory<T>().update(
        table.name,
        serializedRecord as Partial<T>,
        qb,
        this.statementConfigFactory.getStatementConfig(config)
      );
    const recordUpdateCount = await this.dbDriver.runDml(generateUpdate);
    await this.tableWatcherRunner.runAfterUpdateTableWatchers(table, recordUpdateCount, recordCopy, qb);
    return recordUpdateCount;
  }

  private async addUpdateFieldValues<T extends R>(table: Table<T>, record: any) {
    for (const columnPropertyName in table.columns) {
      const column = (table.columns as any)[columnPropertyName] as Column<any, any>;
      if (column.options?.updateValue) {
        record[columnPropertyName] = await column.options.updateValue(record);
      }
    }
  }

  async delete<T extends R>(table: Table<T>, query: Query<T>): Promise<number> {
    if (!this.runAsSystem) {
      this.auth.canDelete(table);
    }

    const qb = new QueryBuilderFactory().getQueryBuilder(table, query);
    const recordsToDelete = await this.query(table, qb);
    if (recordsToDelete.length == 0) {
      return 0;
    }

    const recordsToDeleteIds = recordsToDelete.map((record) => record.id);
    const deleteQb = new QueryBuilderFactory().getQueryBuilder(table);
    deleteQb.condition({ field: 'id', operator: 'IN', value: recordsToDeleteIds as T[keyof T][] });
    const generateDelete = (config: DbDriverDmlStatementConfig) =>
      new StatementFactory<T>().delete(table.name, deleteQb, this.statementConfigFactory.getStatementConfig(config));
    await this.runColumnBeforeDeletes(table, recordsToDelete);
    await this.tableWatcherRunner.runBeforeDeleteTableWatchers(table, recordsToDelete, qb);
    const recordDeleteCount = await this.dbDriver.runDml(generateDelete);
    await this.runCascadeDeletions(table, recordsToDeleteIds);
    await this.tableWatcherRunner.runAfterDeleteTableWatchers(table, recordDeleteCount, recordsToDelete, qb);
    return recordDeleteCount;
  }

  private async runColumnBeforeDeletes(table: Table<any>, recordsToDelete: Record[]) {
    for (const columnPropertyName in table.columns) {
      const column = (table.columns as any)[columnPropertyName] as Column<any, any>;
      if (typeof column.beforeDelete !== 'undefined') {
        await column.beforeDelete(table, columnPropertyName, recordsToDelete);
      }
    }
  }

  private async runCascadeDeletions(table: Table<any>, deletedRecordIds: string[]) {
    if (table.cascadeDeleteReferences().length < 1) {
      return;
    }

    for (const cascadeDeleteReference of table.cascadeDeleteReferences()) {
      const referenceTable = tableByName(cascadeDeleteReference.table);
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

  async query<T extends R>(table: Table<T>, query: Query<T>): Promise<T[]> {
    if (!this.runAsSystem) {
      this.auth.canQuery(table);
    }

    const qb = new QueryBuilderFactory().getQueryBuilder(table, query);
    this.addColumnQueries(table, qb);
    const generateQuery = (config: DbDriverQueryStatementConfig) =>
      qb.toSql(this.statementConfigFactory.getStatementConfig(config));
    const serializedRecords = await this.dbDriver.runQuery(generateQuery);
    const recordSearializer = new RecordSerializer(table);
    return await Promise.all(
      serializedRecords.map(async (serializedRecord) => recordSearializer.deserialize(serializedRecord))
    );
  }

  async getRowCount<T extends R>(table: Table<T>, query?: Query<T>): Promise<number> {
    if (!this.runAsSystem) {
      this.auth.canQuery(table);
    }

    const qb = new QueryBuilderFactory().getQueryBuilder(table, query);
    qb.aggregate({ function: 'COUNT', resultProp: 'count' });
    this.addColumnQueries(table, qb);
    const generateQuery = (config: DbDriverQueryStatementConfig) =>
      qb.toSql(this.statementConfigFactory.getStatementConfig(config));
    const result = await this.dbDriver.runQuery(generateQuery);
    return result[0]['count'];
  }

  private async addColumnQueries<T extends R>(table: Table<T>, qb: QueryBuilder<T>) {
    for (const columnPropertyName in table.columns) {
      const column = (table.columns as any)[columnPropertyName] as Column<any, any>;
      if (column.options?.addToQuery) {
        column.options.addToQuery(qb, this.runAsSystem);
      }
    }
  }
}
