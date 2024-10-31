import { Database, Instance, Spanner, Transaction } from '@google-cloud/spanner';
import {
  DbDriver,
  DbDriverQueryStatementConfig,
  DbDriverDmlStatementConfig,
  Table,
  TableManager,
  tableByName,
} from '@proteinjs/db';
import { SpannerConfig } from './SpannerConfig';
import { Logger } from '@proteinjs/logger';
import { Statement } from '@proteinjs/db-query';
import { SpannerSchemaOperations } from './SpannerSchemaOperations';
import { SpannerColumnTypeFactory } from './SpannerColumnTypeFactory';
import { SpannerSchemaMetadata } from './SpannerSchemaMetadata';

export class SpannerDriver implements DbDriver {
  private static SPANNER: Spanner;
  private static SPANNER_INSTANCE: Instance;
  private static SPANNER_DB: Database;
  private logger = new Logger({ name: this.constructor.name });
  private config: SpannerConfig;
  public getTable: ((name: string) => Table<any>) | undefined;

  constructor(config: SpannerConfig, getTable?: (name: string) => Table<any>) {
    this.config = config;
    this.getTable = getTable;
  }

  private getSpanner(): Spanner {
    if (!SpannerDriver.SPANNER) {
      if (this.config.spannerOptions) {
        SpannerDriver.SPANNER = new Spanner(
          Object.assign({ projectId: this.config.projectId }, this.config.spannerOptions)
        );
      } else {
        SpannerDriver.SPANNER = new Spanner({ projectId: this.config.projectId });
      }
    }

    return SpannerDriver.SPANNER;
  }

  private getSpannerInstance(): Instance {
    if (!SpannerDriver.SPANNER_INSTANCE) {
      SpannerDriver.SPANNER_INSTANCE = this.getSpanner().instance(this.config.instanceName);
    }

    return SpannerDriver.SPANNER_INSTANCE;
  }

  private getSpannerDb(): Database {
    if (!SpannerDriver.SPANNER_DB) {
      SpannerDriver.SPANNER_DB = this.getSpannerInstance().database(this.config.databaseName);
    }

    return SpannerDriver.SPANNER_DB;
  }

  getDbName() {
    return this.config.databaseName;
  }

  getTableManager(): TableManager {
    const columnTypeFactory = new SpannerColumnTypeFactory();
    const schemaOperations = new SpannerSchemaOperations(this);
    const schemaMetadata = new SpannerSchemaMetadata(this, false);
    return new TableManager(this, columnTypeFactory, schemaOperations, schemaMetadata);
  }

  /**
   * Retrieves spanner specific types for columns.
   * @param tableName Table name as it is represented in the db
   * @param columnName Column name as it is represented in the db
   * @returns
   */
  getColumnType(tableName: string, columnName: string): string {
    const table = this.getTable ? this.getTable(tableName) : tableByName(tableName);
    const column = Object.values(table.columns).find((col) => col.name === columnName);

    if (!column) {
      throw new Error(`Column ${columnName} does not exist in table ${table.name}`);
    }

    const type = new SpannerColumnTypeFactory().getType(column, true);

    if (!type) {
      throw new Error(`Type was not resolved for column ${columnName} in table ${table.name}`);
    }

    return type;
  }

  /**
   * Spanner is case sensitive by default.
   * If we want to query without case sensitivity, wrap the column name with the `LOWER()` function.
   * @returns identifier to be used in SQL statement, may instead be an expression if using case insensitivity
   */
  handleCaseSensitivity(tableName: string, columnName: string, caseSensitive: boolean): string {
    if (caseSensitive) {
      return columnName;
    }

    const isStringColType = this.getColumnType(tableName, columnName) === 'string';

    if (isStringColType) {
      return `LOWER(${columnName})`;
    }

    return columnName;
  }

  async createDbIfNotExists(): Promise<void> {
    if (await this.dbExists(this.getDbName())) {
      return;
    }

    await this.getSpannerInstance().createDatabase(this.getDbName());
  }

  private async dbExists(databaseName: string): Promise<boolean> {
    const [exists] = await this.getSpannerInstance().database(databaseName).exists();
    return exists;
  }

  /**
   * Execute a query.
   */
  async runQuery(
    generateStatement: (config: DbDriverQueryStatementConfig) => Statement,
    transaction?: Transaction
  ): Promise<any[]> {
    return await this.executeQuery(generateStatement, transaction || this.getSpannerDb());
  }

  private async executeQuery(
    generateStatement: (config: DbDriverQueryStatementConfig) => Statement,
    runner: Database | Transaction
  ): Promise<any[]> {
    const { sql, namedParams } = generateStatement({
      useParams: true,
      useNamedParams: true,
      prefixTablesWithDb: false,
      getDriverColumnType: this.getColumnType.bind(this),
      handleCaseSensitivity: this.handleCaseSensitivity.bind(this),
    });

    try {
      this.logger.debug({ message: `Executing query`, obj: { sql, params: namedParams } });
      const [rows] = await runner.run({
        sql,
        params: namedParams?.params,
        types: namedParams?.types,
      });
      return rows.map((row) => row.toJSON());
    } catch (error: any) {
      this.logger.error({
        message: `Failed when executing query`,
        obj: { sql, params: namedParams, errorDetails: error.details },
      });
      throw error;
    }
  }

  /**
   * Execute a write operation.
   *
   * @returns number of affected rows
   */
  async runDml(
    generateStatement: (config: DbDriverDmlStatementConfig) => Statement,
    transaction?: Transaction
  ): Promise<number> {
    if (transaction) {
      return await this.executeDml(generateStatement, transaction);
    }

    return await this.getSpannerDb().runTransactionAsync(async (transaction) => {
      const rowCount = await this.executeDml(generateStatement, transaction);
      await transaction.commit();
      return rowCount;
    });
  }

  private async executeDml(
    generateStatement: (config: DbDriverDmlStatementConfig) => Statement,
    runner: Transaction
  ): Promise<number> {
    const { sql, namedParams } = generateStatement({
      useParams: true,
      useNamedParams: true,
      prefixTablesWithDb: false,
      getDriverColumnType: this.getColumnType.bind(this),
    });

    try {
      this.logger.debug({ message: `Executing dml`, obj: { sql, params: namedParams } });
      const [rowCount] = await runner.runUpdate({
        sql,
        params: namedParams?.params,
        types: namedParams?.types,
      });
      return rowCount;
    } catch (error: any) {
      this.logger.error({
        message: `Failed when executing dml`,
        obj: { sql, params: namedParams, errorDetails: error.details },
      });
      throw error;
    }
  }

  /**
   * Execute a transaction.
   * @param fn all db operations within this function will be part of this transaction
   * @returns the return of the `fn`
   */
  async runTransaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    return await this.getSpannerDb().runTransactionAsync(async (transaction) => {
      const result = await fn(transaction);
      await transaction.commit();
      return result;
    });
  }

  /**
   * Execute a schema write operation.
   */
  async runUpdateSchema(sql: string): Promise<void> {
    try {
      this.logger.debug({ message: `Executing schema update`, obj: { sql } });
      const [operation] = await this.getSpannerDb().updateSchema(sql);
      await operation.promise();
    } catch (error: any) {
      this.logger.error({ message: `Failed when executing schema update`, obj: { sql, errorDetails: error.details } });
      throw error;
    }
  }
}
