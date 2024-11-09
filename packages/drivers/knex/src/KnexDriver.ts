import knex, { Transaction } from 'knex';
import {
  DbDriver,
  DbDriverQueryStatementConfig,
  DbDriverDmlStatementConfig,
  SerializedRecord,
  Table,
  TableManager,
  tableByName,
} from '@proteinjs/db';
import { KnexConfig } from './KnexConfig';
import { Logger } from '@proteinjs/logger';
import { Statement } from '@proteinjs/db-query';
import { KnexSchemaOperations } from './KnexSchemaOperations';
import { KnexColumnTypeFactory } from './KnexColumnTypeFactory';

/**
 * Knex driver (configured for MariaDb) for ProteinJs Db
 */
export class KnexDriver implements DbDriver {
  private static KNEX: knex;
  private logger = new Logger({ name: this.constructor.name });
  private config: KnexConfig;
  private knexConfig: any;
  public getTable: ((name: string) => Table<any>) | undefined;

  constructor(config: KnexConfig, getTable?: (name: string) => Table<any>) {
    this.config = config;
    this.knexConfig = {
      client: 'mysql',
      connection: {
        host: this.config.host,
        user: this.config.user,
        password: this.config.password,
      },
    };
    this.getTable = getTable;
  }

  getKnex(): knex {
    if (!KnexDriver.KNEX) {
      KnexDriver.KNEX = knex(this.knexConfig);
    }

    return KnexDriver.KNEX;
  }

  getDbName() {
    return this.config.dbName as string;
  }

  async createDbIfNotExists(): Promise<void> {
    if (await this.dbExists(this.getDbName())) {
      return;
    }

    await this.getKnex().raw(`CREATE DATABASE ${this.getDbName()};`);
  }

  private async dbExists(databaseName: string): Promise<boolean> {
    const result: any = await this.getKnex().raw('SHOW DATABASES;');
    for (const existingDatabase of result[0]) {
      if (existingDatabase['Database'] == databaseName) {
        return true;
      }
    }

    return false;
  }

  async start() {
    await this.setMaxAllowedPacketSize();
    await this.createDbIfNotExists();
  }

  async stop() {
    await this.getKnex().destroy();
  }

  private async setMaxAllowedPacketSize(): Promise<void> {
    await this.getKnex().raw('SET GLOBAL max_allowed_packet=1073741824;');
    await this.getKnex().destroy();
    KnexDriver.KNEX = knex(this.knexConfig);
    this.logger.info({ message: 'Set global max_allowed_packet size to 1gb' });
  }

  getTableManager(): TableManager {
    const columnTypeFactory = new KnexColumnTypeFactory();
    const schemaOperations = new KnexSchemaOperations(this);
    return new TableManager(this, columnTypeFactory, schemaOperations);
  }

  /**
   * MariaDB is case insensitive by default.
   * If we want to query with case sensitivity, prepend the column name with the `BINARY` keyword.
   * @returns identifier to be used in SQL statement, may contain modifier if using case sensitivity
   */
  handleCaseSensitivity(tableName: string, columnName: string, caseSensitive: boolean): string {
    if (!caseSensitive) {
      return columnName;
    }

    const table = this.getTable ? this.getTable(tableName) : tableByName(tableName);
    const column = Object.values(table.columns).find((col) => col.name === columnName);

    if (!column) {
      throw new Error(`Column ${columnName} does not exist in table ${table.name}`);
    }

    const stringColTypes = ['char', 'varchar', 'longtext'];
    const isStringColType = stringColTypes.includes(new KnexColumnTypeFactory().getType(column));

    if (isStringColType) {
      return `BINARY ${columnName}`;
    }

    return columnName;
  }

  async runQuery(
    generateStatement: (config: DbDriverQueryStatementConfig) => Statement,
    transaction?: Transaction
  ): Promise<SerializedRecord[]> {
    const { sql, params } = generateStatement({
      useParams: true,
      prefixTablesWithDb: true,
      handleCaseSensitivity: this.handleCaseSensitivity.bind(this),
    });

    try {
      const runner = transaction || this.getKnex();
      return (await runner.raw(sql, params as any))[0]; // returns 2 arrays, first is records, second is metadata per record
    } catch (error: any) {
      this.logger.error({ message: `Failed when executing sql`, obj: { sql }, error });
      throw error;
    }
  }

  async runDml(
    generateStatement: (config: DbDriverDmlStatementConfig) => Statement,
    transaction?: Transaction
  ): Promise<number> {
    const { affectedRows } = (await this.runQuery(generateStatement, transaction)) as any;
    return affectedRows;
  }

  /**
   * Execute a transaction.
   * @param fn all db operations within this function will be part of this transaction
   * @returns the return value of the `fn`
   */
  async runTransaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    return await this.getKnex().transaction(async (trx) => {
      const result = await fn(trx);
      return result;
    });
  }
}
