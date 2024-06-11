import { Database, Instance, Spanner } from '@google-cloud/spanner';
import { DbDriver, DbDriverStatementConfig, Table, TableManager, tableByName } from '@proteinjs/db';
import { SpannerConfig } from './SpannerConfig';
import { Logger } from '@proteinjs/util';
import { Statement } from '@proteinjs/db-query';
import { SpannerSchemaOperations } from './SpannerSchemaOperations';
import { SpannerColumnTypeFactory } from './SpannerColumnTypeFactory';
import { SpannerSchemaMetadata } from './SpannerSchemaMetadata';

export class SpannerDriver implements DbDriver {
  private static SPANNER: Spanner;
  private static SPANNER_INSTANCE: Instance;
  private static SPANNER_DB: Database;
  private logger = new Logger(this.constructor.name);
  private config: SpannerConfig;
  public getTable: ((name: string) => Table<any>) | undefined;

  constructor(config: SpannerConfig, getTable?: (name: string) => Table<any>) {
    this.config = config;
    this.getTable = getTable;
    const logger = new Logger('SpannerDriver');
    logger.info(`getTable from constructor: ${this.getTable}`);
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

  getColumnType(tableName: string, columnPropertyName: string): string {
    const logger = new Logger('getColumnType');
    logger.info(`getTable: ${this.getTable}`);
    const table = this.getTable ? this.getTable(tableName) : tableByName(tableName);
    const column = Object.values(table.columns).find((col) => col.name === columnPropertyName);

    if (!column) {
      throw new Error(`(${table.name}) Column does not exist for property: ${columnPropertyName}`);
    }

    return new SpannerColumnTypeFactory().getType(column, true);
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

  async runQuery(generateStatement: (config: DbDriverStatementConfig) => Statement): Promise<any[]> {
    const { sql, namedParams } = generateStatement({
      useParams: true,
      useNamedParams: true,
      prefixTablesWithDb: false,
    });
    try {
      this.logger.debug(`Executing query: ${sql}`);
      const [rows] = await this.getSpannerDb().run({ sql, params: namedParams?.params });
      return rows.map((row) => row.toJSON());
      // return JSON.parse(JSON.stringify((await this.getSpannerDb().run({ sql, params: namedParams?.params }))[0]));
    } catch (error: any) {
      this.logger.error(
        `Failed when executing query: ${sql}\nparams: ${JSON.stringify(namedParams, null, 2)}\nreason: ${error.details}`
      );
      throw error;
    }
  }

  /**
   * Execute a write operation.
   *
   * @returns number of affected rows
   */
  async runDml(generateStatement: (config: DbDriverStatementConfig) => Statement): Promise<number> {
    const { sql, namedParams } = generateStatement({
      useParams: true,
      useNamedParams: true,
      prefixTablesWithDb: false,
      getColumnType: this.getColumnType.bind(this),
    });
    try {
      return await this.getSpannerDb().runTransactionAsync(async (transaction) => {
        this.logger.debug(`Executing dml: ${sql}`);
        const [rowCount] = await transaction.runUpdate({
          sql,
          params: namedParams?.params,
          types: namedParams?.types,
        });
        await transaction.commit();
        return rowCount;
      });
    } catch (error: any) {
      this.logger.error(
        `Failed when executing dml: ${sql}\nparams: ${JSON.stringify(namedParams, null, 2)}\nreason: ${error.details}`
      );
      throw error;
    }
  }

  /**
   * Execute a schema write operation.
   */
  async runUpdateSchema(sql: string): Promise<void> {
    try {
      this.logger.debug(`Executing schema update: ${sql}`);
      const [operation] = await this.getSpannerDb().updateSchema(sql);
      await operation.promise();
    } catch (error: any) {
      this.logger.error(`Failed when executing schema update: ${sql}\nreason: ${error.details}`);
      throw error;
    }
  }
}
