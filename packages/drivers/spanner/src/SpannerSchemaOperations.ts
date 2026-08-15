import { Logger } from '@proteinjs/logger';
import {
  Table,
  SchemaOperations,
  TableChanges,
  StatementFactory,
  AlterTableParams,
  StatementUtil,
} from '@proteinjs/db';
import { SpannerDriver } from './SpannerDriver';
import { SpannerColumnTypeFactory } from './SpannerColumnTypeFactory';

const getEnvVar = (key: string): string | undefined =>
  typeof process !== 'undefined' && process.env ? process.env[key] : undefined;

export class SpannerSchemaOperations implements SchemaOperations {
  private logger = new Logger({ name: this.constructor.name, logLevel: getEnvVar('DB_LOG_LEVEL') as any });

  constructor(private spannerDriver: SpannerDriver) {}

  /**
   * Classify a schema-update error as Spanner's "already exists" class — the loser's outcome when
   * two actors concurrently create the same table/index or add the same column and the backend
   * serializes the DDL so it lands exactly once. {@link TableManager} calls this to decide whether
   * a create/alter failure is eligible for verify-then-succeed (it still re-reads the live schema
   * and confirms the intended definition before treating it as success).
   *
   * Matched on gRPC status CODE and a specific MESSAGE class — never a loose substring:
   * - code ∈ { ALREADY_EXISTS (6), FAILED_PRECONDITION (9) }. Cloud Spanner has surfaced the
   *   duplicate-object errors under both across backends/versions; the emulator returns 9
   *   ("Duplicate name in schema: <obj>" for a table/index, "Duplicate column name <table>.<col>"
   *   for a column — verified against the emulator image, 2026-08). Gating on this two-code family
   *   rather than code 9 alone keeps OTHER FAILED_PRECONDITION errors — a stranded read-write
   *   transaction ("a concurrent schema change operation or read-write transaction is already in
   *   progress"), a unique-index backfill uniqueness violation — out of the class.
   * - message ∈ the duplicate/already-exists phrasings. This is the discriminator that keeps
   *   unrelated code-9 errors out, so it is deliberately specific (e.g. "already in progress" does
   *   NOT contain "already exists" and is not matched).
   *
   * The reconcile layer's own errors (unsupported type change, nullable drift, column rename) are
   * plain Errors with no `code` and never match.
   */
  isAlreadyExistsError(error: unknown): boolean {
    const code = (error as { code?: number } | undefined)?.code;
    if (code !== 6 && code !== 9) {
      return false;
    }

    const message = String((error as { message?: unknown } | undefined)?.message ?? '');
    return (
      /Duplicate column name/i.test(message) ||
      /Duplicate name in schema/i.test(message) ||
      /already exists/i.test(message)
    );
  }

  /**
   * Create every table in `tables` — each table's `CREATE TABLE` plus all of its `CREATE INDEX`
   * statements, concatenated across tables in the given order — as ONE schema-update operation.
   * `UpdateDatabaseDdl` applies the batch in order, so a table whose foreign keys reference an
   * earlier table in the list resolves against it, exactly as it did when the statements ran
   * serially.
   */
  async createTables(tables: Table<any>[]) {
    const statements: string[] = [];
    for (const table of tables) {
      statements.push(...this.createTableStatements(table));
    }

    if (statements.length === 0) {
      return;
    }

    await this.spannerDriver.runUpdateSchema(statements);
  }

  async alterTable(table: Table<any>, tableChanges: TableChanges) {
    const alterParams: AlterTableParams = {
      tableName: table.name,
      columnsToAdd: [],
      foreignKeysToDrop: [],
      foreignKeysToAdd: [],
      columnRenames: [],
    };
    const indexesToDrop = tableChanges.indexesToDrop;
    const indexesToAdd = tableChanges.indexesToCreate;
    for (const columnPropertyName of tableChanges.columnsToCreate) {
      const column = table.columns[columnPropertyName];
      const columnType = new SpannerColumnTypeFactory().getType(column);
      alterParams.columnsToAdd?.push({ name: column.name, type: columnType, nullable: column.options?.nullable });
      this.logger.info({ message: `[${table.name}] Creating column: ${column.name} (${column.constructor.name})` });
      if (column.options?.unique?.unique && tableChanges.columnsWithUniqueConstraintsToCreate.includes(column.name)) {
        indexesToAdd.push({ name: column.options.unique.indexName, columns: column.name, unique: true });
        this.logger.info({ message: `[${table.name}.${column.name}] Adding unique constraint` });
      }

      if (column.options?.references && tableChanges.columnsWithForeignKeysToCreate.includes(column.name)) {
        alterParams.foreignKeysToAdd?.push({
          table: column.options.references.table,
          column: 'id',
          referencedByColumn: column.name,
        });
        this.logger.info({
          message: `[${table.name}.${column.name}] Adding foreign key -> ${column.options.references.table}.id`,
        });
      }
    }

    for (const columnName of tableChanges.columnsWithUniqueConstraintsToDrop) {
      indexesToDrop.push({ columns: columnName, unique: true });
      this.logger.info({ message: `[${table.name}.${columnName}] Dropping unique constraint` });
    }

    for (const foreignKey of tableChanges.foreignKeysToDrop) {
      alterParams.foreignKeysToDrop?.push(foreignKey);
      this.logger.info({
        message: `[${table.name}.${foreignKey.referencedByColumn}] Dropping foreign key -> ${foreignKey.table}.${foreignKey.column}`,
      });
    }

    const wideningStatements: string[] = [];
    for (const columnTypeChange of tableChanges.columnTypeChanges) {
      const wideningStatement = this.stringWideningStatement(table, columnTypeChange);
      if (!wideningStatement) {
        const errorMessage = `[${table.name}.${columnTypeChange.name}] Unable to change column types in Spanner (only STRING widening is supported in place). Attempted to change type from: ${columnTypeChange.oldType} to: ${columnTypeChange.newType}`;
        this.logger.error({ message: errorMessage });
        throw new Error(errorMessage);
      }
      this.logger.info({
        message: `[${table.name}.${columnTypeChange.name}] Widening column: ${columnTypeChange.oldType} -> ${columnTypeChange.newType}`,
      });
      wideningStatements.push(wideningStatement);
    }

    for (const columnNullableChange of tableChanges.columnNullableChanges) {
      const errorMessage = `[${table.name}.${columnNullableChange.name}] Unable to update nullable constraint on existing column in Spanner. Attempted to update nullable constraint to: ${columnNullableChange.nullable === true}`;
      this.logger.error({ message: errorMessage });
      throw new Error(errorMessage);
    }

    for (const columnPropertyName of tableChanges.columnsToRename) {
      const column = table.columns[columnPropertyName];
      const errorMessage = `[${table.name}.${column.oldName}] Unable to rename columns in Spanner. Attempted to perform rename: ${column.oldName} -> ${column.name}`;
      this.logger.error({ message: errorMessage });
      throw new Error(errorMessage);
    }

    // One schema-update operation for the whole alter pass, preserving the statement order the
    // serial version applied: alters (add column / drop+add FK), STRING widenings, index drops,
    // index creates.
    const statements: string[] = new StatementFactory()
      .alterTable(alterParams)
      .map((alterStatement) => alterStatement.sql);
    statements.push(...wideningStatements);

    for (const index of tableChanges.indexesToDrop) {
      this.logger.info({
        message: `[${table.name}] Dropping index: ${index.name} (${typeof index.columns === 'string' ? index.columns : index.columns.join(', ')})`,
      });
      statements.push(new StatementFactory().dropIndex(index, table.name).sql);
    }

    for (const index of tableChanges.indexesToCreate) {
      const indexName = StatementUtil.getIndexName(table.name, index);
      this.logger.info({
        message: `[${table.name}] Creating index: ${indexName} (${typeof index.columns === 'string' ? index.columns : index.columns.join(', ')})`,
      });
      statements.push(new StatementFactory().createIndex(index, table.name).sql);
    }

    if (statements.length === 0) {
      return;
    }

    await this.spannerDriver.runUpdateSchema(statements);
  }

  private createTableStatements(table: Table<any>): string[] {
    const indexes: { name?: string; columns: string[]; unique?: boolean }[] = [];
    for (const { name, columns, unique } of table.indexes) {
      indexes.push({ name, columns: columns.map((x) => table.columns[x as string]!.name), unique });
    }

    const serializedColumns: { name: string; type: string; nullable?: boolean }[] = [];
    const foreignKeys: { table: string; column: string; referencedByColumn: string }[] = [];
    for (const columnPropertyName in table.columns) {
      const column = table.columns[columnPropertyName];
      const columnType = new SpannerColumnTypeFactory().getType(column);
      serializedColumns.push({ name: column.name, type: columnType, nullable: column.options?.nullable });
      this.logger.info({ message: `[${table.name}] Creating column: ${column.name} (${column.constructor.name})` });
      if (column.options?.unique?.unique) {
        indexes.push({
          name: column.options.unique.indexName,
          columns: [table.columns[column.name]!.name],
          unique: true,
        });
        this.logger.info({ message: `[${table.name}.${column.name}] Adding unique constraint` });
      }

      if (column.options?.references) {
        foreignKeys.push({ table: column.options.references.table, column: 'id', referencedByColumn: column.name });
        this.logger.info({
          message: `[${table.name}.${column.name}] Adding foreign key -> ${column.options.references.table}.id`,
        });
      }
    }

    const statements = [new StatementFactory().createTable(table.name, serializedColumns, 'id', foreignKeys).sql];
    for (const index of indexes) {
      const indexName = StatementUtil.getIndexName(table.name, index);
      this.logger.info({
        message: `[${table.name}] Creating index: ${indexName} (${index.columns.join(', ')})`,
      });
      statements.push(new StatementFactory().createIndex(index, table.name).sql);
    }

    return statements;
  }

  /**
   * Spanner supports exactly one in-place column type change: widening a `STRING(n)` to a larger
   * `STRING(m)` or `STRING(MAX)`. Returns the `ALTER COLUMN` statement when `change` is such a
   * widening, or `null` for any other type change. Nullability is restated from the declared
   * column (Spanner's `ALTER COLUMN` replaces the full column definition); nullability DRIFT is
   * rejected separately before this runs, so the declared value matches the live schema here.
   */
  private stringWideningStatement(
    table: Table<any>,
    change: { name: string; newType: string; oldType: string }
  ): string | null {
    const parseStringLength = (type: string): number | 'MAX' | null => {
      const match = /^STRING\((\d+|MAX)\)$/.exec(type);
      if (!match) {
        return null;
      }
      return match[1] === 'MAX' ? 'MAX' : Number(match[1]);
    };
    const oldLength = parseStringLength(change.oldType);
    const newLength = parseStringLength(change.newType);
    const isWidening =
      oldLength !== null && newLength !== null && oldLength !== 'MAX' && (newLength === 'MAX' || newLength > oldLength);
    if (!isWidening) {
      return null;
    }

    const column = Object.values(table.columns).find((tableColumn) => tableColumn.name === change.name);
    const notNull = column?.options?.nullable === false ? ' NOT NULL' : '';
    return `ALTER TABLE \`${table.name}\` ALTER COLUMN \`${change.name}\` ${change.newType}${notNull}`;
  }
}
