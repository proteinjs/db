import { Logger } from '@proteinjs/util';
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

export class SpannerSchemaOperations implements SchemaOperations {
  private logger = new Logger(this.constructor.name);

  constructor(private spannerDriver: SpannerDriver) {}

  async createTable(table: Table<any>) {
    const indexes: { name?: string; columns: string | string[]; unique?: boolean }[] = [];
    for (const index of table.indexes) {
      indexes.push({ name: index.name, columns: index.columns as string[] });
    }

    const serializedColumns: { name: string; type: string; nullable?: boolean }[] = [];
    const foreignKeys: { table: string; column: string; referencedByColumn: string }[] = [];
    for (const columnPropertyName in table.columns) {
      const column = table.columns[columnPropertyName];
      const columnType = new SpannerColumnTypeFactory().getType(column);
      serializedColumns.push({ name: column.name, type: columnType, nullable: column.options?.nullable });
      this.logger.info(`[${table.name}] Creating column: ${column.name} (${column.constructor.name})`);
      if (column.options?.unique?.unique) {
        indexes.push({ name: column.options.unique.indexName, columns: column.name, unique: true });
        this.logger.info(`[${table.name}.${column.name}] Adding unique constraint`);
      }

      if (column.options?.references) {
        foreignKeys.push({ table: column.options.references.table, column: 'id', referencedByColumn: column.name });
        this.logger.info(`[${table.name}.${column.name}] Adding foreign key -> ${column.options.references.table}.id`);
      }
    }
    const createTableSql = new StatementFactory().createTable(table.name, serializedColumns, 'id', foreignKeys).sql;
    await this.spannerDriver.runUpdateSchema(createTableSql);

    for (const index of indexes) {
      const createIndexSql = new StatementFactory().createIndex(index, table.name).sql;
      const indexName = StatementUtil.getIndexName(table.name, index);
      this.logger.info(
        `[${table.name}] Creating index: ${indexName} (${typeof index.columns === 'string' ? index.columns : index.columns.join(', ')})`
      );
      await this.spannerDriver.runUpdateSchema(createIndexSql);
      this.logger.info(
        `[${table.name}] Created index: ${indexName} (${typeof index.columns === 'string' ? index.columns : index.columns.join(', ')})`
      );
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
      this.logger.info(`[${table.name}] Creating column: ${column.name} (${column.constructor.name})`);
      if (column.options?.unique?.unique && tableChanges.columnsWithUniqueConstraintsToCreate.includes(column.name)) {
        indexesToAdd.push({ name: column.options.unique.indexName, columns: column.name, unique: true });
        this.logger.info(`[${table.name}.${column.name}] Adding unique constraint`);
      }

      if (column.options?.references && tableChanges.columnsWithForeignKeysToCreate.includes(column.name)) {
        alterParams.foreignKeysToAdd?.push({
          table: column.options.references.table,
          column: 'id',
          referencedByColumn: column.name,
        });
        this.logger.info(`[${table.name}.${column.name}] Adding foreign key -> ${column.options.references.table}.id`);
      }
    }

    for (const columnName of tableChanges.columnsWithUniqueConstraintsToDrop) {
      indexesToDrop.push({ columns: columnName, unique: true });
      this.logger.info(`[${table.name}.${columnName}] Dropping unique constraint`);
    }

    for (const foreignKey of tableChanges.foreignKeysToDrop) {
      alterParams.foreignKeysToDrop?.push(foreignKey);
      this.logger.info(
        `[${table.name}.${foreignKey.referencedByColumn}] Dropping foreign key -> ${foreignKey.table}.${foreignKey.column}`
      );
    }

    for (const columnTypeChange of tableChanges.columnTypeChanges) {
      const errorMessage = `[${table.name}.${columnTypeChange.name}] Unable to change column types in Spanner. Attempted to change type to: ${columnTypeChange.newType}`;
      this.logger.error(errorMessage);
      throw new Error(errorMessage);
    }

    for (const columnNullableChange of tableChanges.columnNullableChanges) {
      const errorMessage = `[${table.name}.${columnNullableChange.name}] Unable to update nullable constraint on existing column in Spanner. Attempted to update nullable constraint to: ${columnNullableChange.nullable === true}`;
      this.logger.error(errorMessage);
      throw new Error(errorMessage);
    }

    for (const columnPropertyName of tableChanges.columnsToRename) {
      const column = table.columns[columnPropertyName];
      const errorMessage = `[${table.name}.${column.oldName}] Unable to rename columns in Spanner. Attempted to perform rename: ${column.oldName} -> ${column.name}`;
      this.logger.error(errorMessage);
      throw new Error(errorMessage);
    }

    const alterStatements = new StatementFactory().alterTable(alterParams);
    for (const alterStatement of alterStatements) {
      await this.spannerDriver.runUpdateSchema(alterStatement.sql);
    }

    for (const index of tableChanges.indexesToDrop) {
      const dropIndexSql = new StatementFactory().dropIndex(index, table.name).sql;
      this.logger.info(
        `[${table.name}] Dropping index: ${index.name} (${typeof index.columns === 'string' ? index.columns : index.columns.join(', ')})`
      );
      await this.spannerDriver.runUpdateSchema(dropIndexSql);
      this.logger.info(
        `[${table.name}] Dropped index: ${index.name} (${typeof index.columns === 'string' ? index.columns : index.columns.join(', ')})`
      );
    }

    for (const index of tableChanges.indexesToCreate) {
      const createIndexSql = new StatementFactory().createIndex(index, table.name).sql;
      const indexName = StatementUtil.getIndexName(table.name, index);
      this.logger.info(
        `[${table.name}] Creating index: ${indexName} (${typeof index.columns === 'string' ? index.columns : index.columns.join(', ')})`
      );
      await this.spannerDriver.runUpdateSchema(createIndexSql);
      this.logger.info(
        `[${table.name}] Created index: ${indexName} (${typeof index.columns === 'string' ? index.columns : index.columns.join(', ')})`
      );
    }
  }
}
