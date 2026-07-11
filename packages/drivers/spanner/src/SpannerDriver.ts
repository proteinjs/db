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
import { SpannerLivenessMonitor } from './SpannerLivenessMonitor';
import { Logger } from '@proteinjs/logger';
import { Statement } from '@proteinjs/db-query';
import { SpannerSchemaOperations } from './SpannerSchemaOperations';
import { SpannerColumnTypeFactory } from './SpannerColumnTypeFactory';
import { SpannerSchemaMetadata } from './SpannerSchemaMetadata';

/**
 * Google Spanner driver for ProteinJs Db
 */
export class SpannerDriver implements DbDriver {
  private static SPANNER: Spanner;
  private static SPANNER_INSTANCE: Instance;
  private static SPANNER_DB: Database;
  private static LIVENESS_MONITOR: SpannerLivenessMonitor;
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
      SpannerDriver.LIVENESS_MONITOR = new SpannerLivenessMonitor(SpannerDriver.SPANNER_DB).start();
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

    const startTime = process.hrtime.bigint();

    try {
      this.logger.debug({ message: `Executing query`, obj: { sql, params: namedParams } });
      const [rows] = await this.logIfStalled(
        'spanner query',
        sql,
        runner.run({
          sql,
          params: namedParams?.params,
          types: namedParams?.types,
        })
      );
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.debug({
        message: `Query executed`,
        obj: { sql, durationMs, rowCount: rows.length },
      });
      return rows.map((row) => row.toJSON());
    } catch (error: any) {
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.error({
        message: `Failed when executing query`,
        obj: { sql, params: namedParams, errorDetails: error.details, durationMs },
      });
      SpannerDriver.LIVENESS_MONITOR.reportError(error);
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

    // Stalls in the transaction wrapper itself (session acquisition / begin / commit) happen
    // OUTSIDE executeDml's instrumentation — wrap the whole round trip too.
    return await this.logIfStalled(
      'spanner dml transaction',
      '(runTransactionAsync)',
      this.getSpannerDb().runTransactionAsync(async (transaction) => {
        const rowCount = await this.executeDml(generateStatement, transaction);
        await transaction.commit();
        return rowCount;
      })
    );
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

    const startTime = process.hrtime.bigint();

    try {
      this.logger.debug({ message: `Executing dml`, obj: { sql, params: namedParams } });
      const [rowCount] = await this.logIfStalled(
        'spanner dml',
        sql,
        runner.runUpdate({
          sql,
          params: namedParams?.params,
          types: namedParams?.types,
        })
      );
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.debug({
        message: `Dml executed`,
        obj: { sql, durationMs, rowCount },
      });
      return rowCount;
    } catch (error: any) {
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.error({
        message: `Failed when executing dml`,
        obj: { sql, params: namedParams, errorDetails: error.details, durationMs },
      });
      SpannerDriver.LIVENESS_MONITOR.reportError(error);
      throw error;
    }
  }

  /**
   * Execute a transaction.
   * @param fn all db operations within this function will be part of this transaction
   * @returns the return of the `fn`
   */
  async runTransaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    return await this.logIfStalled(
      'spanner transaction',
      '(runTransactionAsync)',
      this.getSpannerDb().runTransactionAsync(async (transaction) => {
        const result = await fn(transaction);
        await transaction.commit();
        return result;
      })
    );
  }

  /**
   * Stall diagnostics (2026-07-10 flow-hang investigation): background flow tasks intermittently
   * wedge between model calls with every model-layer guard silent — the remaining awaits on that
   * path are Spanner ops, and this client has NO acquire/read timeouts (a wedged session/gRPC
   * stream waits forever). Logs ops still pending at 30s and 120s — with the op and statement —
   * then keeps waiting: pure diagnosis, zero behavior change.
   */
  private logIfStalled<T>(op: string, sql: string, promise: PromiseLike<T>, timeoutMs = 30_000): Promise<T> {
    let settled = false;
    const logStall = (afterMs: number) =>
      this.logger.error({
        message: `Spanner op stalled: ${op}`,
        obj: { afterMs, sql: String(sql).slice(0, 200) },
      });
    const t1 = setTimeout(() => {
      if (!settled) {
        logStall(timeoutMs);
      }
    }, timeoutMs);
    const t2 = setTimeout(() => {
      if (!settled) {
        logStall(120_000);
      }
    }, 120_000);
    t1.unref?.();
    t2.unref?.();
    return Promise.resolve(promise).finally(() => {
      settled = true;
      clearTimeout(t1);
      clearTimeout(t2);
    });
  }

  /**
   * Execute a schema write operation.
   */
  async runUpdateSchema(sql: string): Promise<void> {
    const startTime = process.hrtime.bigint();
    try {
      this.logger.debug({ message: `Executing schema update`, obj: { sql } });
      const [operation] = await this.getSpannerDb().updateSchema(sql);
      await operation.promise();
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.debug({ message: `Schema update executed`, obj: { sql, durationMs } });
    } catch (error: any) {
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.error({
        message: `Failed when executing schema update`,
        obj: { sql, errorDetails: error.details, durationMs },
      });
      throw error;
    }
  }
}
