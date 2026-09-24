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

/**
 * A statement's bindings as a log line carries them: positional bindings by position, a bindings
 * dictionary by entry name — or the one word for bindings that could not be read at all.
 */
type ParamsDescription = ParamDescription[] | { [name: string]: ParamDescription } | 'unreadable';

/** A failure as the log line carries it: the error's name, the vendor's codes and the server's own message. */
type FailureCauseSummary = { name?: string; code?: string; errno?: number; sqlState?: string; sqlMessage?: string };

/**
 * Knex driver (configured for MariaDb) for ProteinJs Db
 */
export class KnexDriver implements DbDriver {
  private static KNEX: knex;
  /** The per-operation deadline when `KnexConfig.operationDeadlineMs` is unset (see getOperationDeadlineMs). */
  private static readonly DEFAULT_OPERATION_DEADLINE_MS = 60_000;
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
      // returns 2 arrays, first is records, second is metadata per record
      return (await runner.raw(sql, params as any).timeout(this.getOperationDeadlineMs(), { cancel: true }))[0];
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
   * The deadline every statement runs under — `KnexConfig.operationDeadlineMs`, 60 s when unset —
   * and the one place the driver reads it: the deadline this reports is the deadline runQuery
   * enforces (the query layer's timeout, cancelling the statement on the server when it fires).
   */
  getOperationDeadlineMs(): number {
    return this.config.operationDeadlineMs ?? KnexDriver.DEFAULT_OPERATION_DEADLINE_MS;
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
   *
   * `params` is whatever the statement carried. `Statement` types it as an array, but the query
   * layer also accepts a bindings dictionary (and wraps anything else as one binding), and
   * runQuery forwards what it was handed — so nothing here may assume a shape. The line is
   * written through writeStatementLine: it sits on the way to a `throw`, and must never be the
   * reason something else is thrown.
   */
  private logFailure(sql: string, params: unknown, error: unknown): void {
    this.writeStatementLine(() =>
      this.logger.error({
        message: `Failed when executing sql`,
        obj: {
          sql,
          params: this.describeParams(params),
          ...KnexLogValues.ofStatement(params),
          cause: this.causeSummary(error),
        },
        ...KnexLogValues.ofFailure(error),
      })
    );
  }

  /**
   * The ONE door a statement's log line is written through — the owner of the rule that writing
   * a line can NEVER change what the driver throws. A statement line is written on the way to a
   * `throw`, so whatever goes wrong while building or writing it — a log writer that is down, a
   * serializer meeting a value it cannot print (a bigint or a throwing `toJSON`, under the values
   * switch), a helper meeting a shape nobody foresaw — is caught HERE and reported as one FIXED
   * line that carries nothing of the statement; the caller then throws exactly what it was going
   * to throw. If the logger itself is what failed, the fixed line fails too and is dropped:
   * nothing is left to write with.
   */
  private writeStatementLine(write: () => void): void {
    try {
      write();
    } catch {
      try {
        this.logger.error({ message: `Failed to write a statement log line` });
      } catch {
        // The logger itself is what failed: nothing is left to write with, and nothing here may throw.
      }
    }
  }

  /**
   * The name, codes and server message of any thrown value — never the query layer's rewritten
   * `message` or `sql`. Total: a fact that cannot be read (vendorFact) is left out.
   */
  private causeSummary(error: unknown): FailureCauseSummary {
    const name = this.vendorFact(error, 'name');
    const code = this.vendorFact(error, 'code');
    const errno = this.vendorFact(error, 'errno');
    const sqlState = this.vendorFact(error, 'sqlState');
    const sqlMessage = this.vendorFact(error, 'sqlMessage');
    return {
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof errno === 'number' ? { errno } : {}),
      ...(typeof sqlState === 'string' ? { sqlState } : {}),
      ...(typeof sqlMessage === 'string' ? { sqlMessage } : {}),
    };
  }

  /**
   * A statement's bound parameters as a LOG LINE carries them — the one owner of that form: by
   * position, the KIND of each value and, for strings, arrays and bytes, its LENGTH. Never a
   * value: a parameter is row content (a presented token, a credential hash, an address), and a
   * log line outlives and out-travels the row it came from. The SQL text beside it carries `?`
   * placeholders only, so position + kind + length is what locates a failure (which parameter was
   * null, which was oversized) without quoting it.
   *
   * The shapes are the query layer's own: positional bindings (an array) are described by
   * POSITION; a bindings DICTIONARY (a plain object, bound to `:name` placeholders) by entry
   * NAME; no bindings describe nothing; and anything else — null, a scalar, a Map, a Date — is
   * what the query layer binds as ONE parameter, so it is described as one.
   *
   * TOTAL, for any input: a value that cannot be read is described as `unreadable`
   * (describeParam), and bindings that cannot even be walked are the one word `unreadable`.
   */
  private describeParams(params?: unknown): ParamsDescription | undefined {
    if (params === undefined) {
      return undefined;
    }
    try {
      if (Array.isArray(params)) {
        const described: ParamDescription[] = [];
        for (let position = 0; position < params.length; position++) {
          described.push(this.describeParam(() => params[position]));
        }
        return described;
      }
      if (this.isDictionary(params)) {
        const described: { [name: string]: ParamDescription } = {};
        for (const name of Object.keys(params)) {
          described[name] = this.describeParam(() => params[name]);
        }
        return described;
      }
      return [this.describeParam(() => params)];
    } catch {
      return 'unreadable';
    }
  }

  /**
   * One bound value, described: its kind, a length for strings, arrays and bytes, null named. The
   * value is READ in here (`read`), so a read that throws — an accessor, a revoked proxy — is
   * described as `unreadable` and its neighbours still are described. A length that is not a
   * number is no length: nothing a value says about itself rides the line but that one number.
   */
  private describeParam(read: () => unknown): ParamDescription {
    try {
      const value = read();
      const description: ParamDescription = { type: this.paramKind(value) };
      if (typeof value === 'string' || Array.isArray(value) || value instanceof Uint8Array) {
        const length: unknown = value.length;
        if (typeof length === 'number') {
          description.length = length;
        }
      }
      if (value === null || value === undefined) {
        description.null = true;
      }
      return description;
    } catch {
      return { type: 'unreadable' };
    }
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

  /** Whether bindings are a DICTIONARY — a plain object, which the query layer binds by entry name. */
  private isDictionary(params: unknown): params is { [name: string]: unknown } {
    if (typeof params !== 'object' || params === null) {
      return false;
    }
    const prototype = Object.getPrototypeOf(params);
    return prototype === null || Object.getPrototypeOf(prototype) === null;
  }

  /** One fact of a thrown value, or nothing when it cannot be read (nothing thrown, a scalar, a throwing accessor). */
  private vendorFact(error: unknown, fact: keyof FailureCauseSummary): unknown {
    try {
      return (error as { [fact: string]: unknown } | null | undefined)?.[fact];
    } catch {
      return undefined;
    }
  }
}
