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

  async createTable(table: Table<any>) {
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
    const createTableSql = new StatementFactory().createTable(table.name, serializedColumns, 'id', foreignKeys).sql;
    await this.spannerDriver.runUpdateSchema(createTableSql);

    for (const index of indexes) {
      const createIndexSql = new StatementFactory().createIndex(index, table.name).sql;
      const indexName = StatementUtil.getIndexName(table.name, index);
      this.logger.info({
        message: `[${table.name}] Creating index: ${indexName} (${index.columns.join(', ')})`,
      });
      await this.spannerDriver.runUpdateSchema(createIndexSql);
      this.logger.info({
        message: `[${table.name}] Created index: ${indexName} (${index.columns.join(', ')})`,
      });
    }
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

    const alterStatements = new StatementFactory().alterTable(alterParams);
    for (const alterStatement of alterStatements) {
      await this.spannerDriver.runUpdateSchema(alterStatement.sql);
    }

    for (const wideningStatement of wideningStatements) {
      await this.spannerDriver.runUpdateSchema(wideningStatement);
    }

    for (const index of tableChanges.indexesToDrop) {
      const dropIndexSql = new StatementFactory().dropIndex(index, table.name).sql;
      this.logger.info({
        message: `[${table.name}] Dropping index: ${index.name} (${typeof index.columns === 'string' ? index.columns : index.columns.join(', ')})`,
      });
      await this.spannerDriver.runUpdateSchema(dropIndexSql);
      this.logger.info({
        message: `[${table.name}] Dropped index: ${index.name} (${typeof index.columns === 'string' ? index.columns : index.columns.join(', ')})`,
      });
    }

    for (const index of tableChanges.indexesToCreate) {
      const createIndexSql = new StatementFactory().createIndex(index, table.name).sql;
      const indexName = StatementUtil.getIndexName(table.name, index);
      this.logger.info({
        message: `[${table.name}] Creating index: ${indexName} (${typeof index.columns === 'string' ? index.columns : index.columns.join(', ')})`,
      });
      await this.spannerDriver.runUpdateSchema(createIndexSql);
      this.logger.info({
        message: `[${table.name}] Created index: ${indexName} (${typeof index.columns === 'string' ? index.columns : index.columns.join(', ')})`,
      });
    }
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
