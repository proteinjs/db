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
import { KnexLogValues } from './KnexLogValues';
import { Logger } from '@proteinjs/logger';
import { Statement } from '@proteinjs/db-query';
import { KnexSchemaOperations } from './KnexSchemaOperations';
import { KnexColumnTypeFactory } from './KnexColumnTypeFactory';

/** A bound parameter as a log line carries it (see KnexDriver.describeParams): never its value. */
type ParamDescription = { type: string; length?: number; null?: true };

/** A failure as the log line carries it: the error's name, the vendor's codes and the server's own message. */
type FailureCauseSummary = { name?: string; code?: string; errno?: number; sqlState?: string; sqlMessage?: string };

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

    await this.createDb(this.getDbName());
  }

  /**
   * Create the named database. MariaDB has no create-with-schema operation (Spanner's
   * `CreateDatabase.extra_statements`), so passing `ddl` here is an error rather than a quiet
   * second apply path — load the schema through `TableManager` after creating.
   */
  async createDb(name: string, options?: { ddl?: string[] }): Promise<void> {
    if (options?.ddl && options.ddl.length > 0) {
      throw new Error(
        `The knex/MariaDB driver does not support create-with-schema (ddl); create the database, then apply schema via TableManager.loadTables`
      );
    }

    await this.getKnex().raw(`CREATE DATABASE ${name};`);
  }

  /** Drop the named database. */
  async dropDb(name: string): Promise<void> {
    await this.getKnex().raw(`DROP DATABASE ${name};`);
  }

  async dbExists(databaseName: string): Promise<boolean> {
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
      // MySQL day/hour/minute truncation for QueryBuilder.timeBucket. These bucket in the SESSION
      // time zone; deployments needing strict UTC buckets should run the connection with time_zone
      // = '+00:00' (the Spanner driver truncates in UTC unconditionally). Hour/minute truncation
      // floors via DATE_FORMAT (a stable, groupable bucket key).
      dateTruncExpression: (resolvedColumnName: string, unit: 'day' | 'hour' | 'minute') =>
        unit === 'minute'
          ? `DATE_FORMAT(${resolvedColumnName}, '%Y-%m-%d %H:%i:00')`
          : unit === 'hour'
            ? `DATE_FORMAT(${resolvedColumnName}, '%Y-%m-%d %H:00:00')`
            : `DATE(${resolvedColumnName})`,
    });

    try {
      const runner = transaction || this.getKnex();
      return (await runner.raw(sql, params as any))[0]; // returns 2 arrays, first is records, second is metadata per record
    } catch (error: unknown) {
      this.logFailure(sql, params, error);
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

  /**
   * The one line a failed statement writes. What is THROWN is the vendor's error itself, untouched
   * (runQuery rethrows it); this is only what the driver PRINTS of it.
   *
   * The vendor error is not safe to print as it is: the query layer rewrites a failed query's
   * `message` to the SQL with its bindings INTERPOLATED, and the client library's error carries
   * the same formatted text as `sql` — every bound value of the statement, on any line the error
   * reaches. So the line carries the SQL text (placeholders only), the parameters DESCRIBED
   * (describeParams) and a summary of the failure: the error's name, the vendor's codes and the
   * server's own message (`sqlMessage` — which can itself quote a value, e.g. a colliding key; the
   * driver prints it as it always has). The vendor error itself, and the values as bound, ride
   * the line only behind the dev-only switch (KnexLogValues).
   */
  private logFailure(sql: string, params: Statement['params'], error: unknown): void {
    this.logger.error({
      message: `Failed when executing sql`,
      obj: {
        sql,
        params: this.describeParams(params),
        ...KnexLogValues.ofStatement(params),
        cause: this.causeSummary(error),
      },
      ...KnexLogValues.ofFailure(error),
    });
  }

  /** The name, codes and server message of any thrown value — never the query layer's rewritten `message` or `sql`. */
  private causeSummary(error: unknown): FailureCauseSummary {
    const vendor = error as { [fact: string]: unknown } | null | undefined;
    return {
      ...(typeof vendor?.name === 'string' ? { name: vendor.name } : {}),
      ...(typeof vendor?.code === 'string' ? { code: vendor.code } : {}),
      ...(typeof vendor?.errno === 'number' ? { errno: vendor.errno } : {}),
      ...(typeof vendor?.sqlState === 'string' ? { sqlState: vendor.sqlState } : {}),
      ...(typeof vendor?.sqlMessage === 'string' ? { sqlMessage: vendor.sqlMessage } : {}),
    };
  }

  /**
   * A statement's bound parameters as a LOG LINE carries them — the one owner of that form: by
   * position, the KIND of each value and, for strings, arrays and bytes, its LENGTH. Never a
   * value: a parameter is row content (a presented token, a credential hash, an address), and a
   * log line outlives and out-travels the row it came from. The SQL text beside it carries `?`
   * placeholders only, so position + kind + length is what locates a failure (which parameter was
   * null, which was oversized) without quoting it.
   */
  private describeParams(params?: Statement['params']): ParamDescription[] | undefined {
    if (!params) {
      return undefined;
    }
    return params.map((value) => {
      const description: ParamDescription = { type: this.paramKind(value) };
      if (typeof value === 'string' || Array.isArray(value) || value instanceof Uint8Array) {
        description.length = value.length;
      }
      if (value === null || value === undefined) {
        description.null = true;
      }
      return description;
    });
  }

  /** The kind of a bound value — a word, never the value. */
  private paramKind(value: unknown): string {
    if (value === null || value === undefined) {
      return 'null';
    }
    if (Array.isArray(value)) {
      return 'array';
    }
    if (value instanceof Date) {
      return 'date';
    }
    if (value instanceof Uint8Array) {
      return 'bytes';
    }
    return typeof value;
  }
}
