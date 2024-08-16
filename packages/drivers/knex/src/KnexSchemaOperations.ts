import * as knex from 'knex';
import { Logger } from '@proteinjs/logger';
import { Column, Table, SchemaOperations, TableChanges } from '@proteinjs/db';
import { KnexDriver } from './KnexDriver';
import { getColumnFactory } from './getColumnFactory';

export class KnexSchemaOperations implements SchemaOperations {
  private logger = new Logger({ name: this.constructor.name });

  constructor(private knexDriver: KnexDriver) {}

  async createTable(table: Table<any>) {
    let resolve: any;
    let reject: any;
    const p = new Promise<void>((rs, rj) => {
      resolve = rs;
      reject = rj;
    });

    await this.knexDriver
      .getKnex()
      .schema.withSchema(this.knexDriver.getDbName())
      .createTable(table.name, (tableBuilder: knex.TableBuilder) => {
        for (const columnPropertyName in table.columns) {
          const column = table.columns[columnPropertyName];
          this.createColumn(column, table, tableBuilder);
          this.logger.info({ message: `[${table.name}] Creating column: ${column.name}` });
        }

        tableBuilder.primary(['id']);
        this.logger.info({ message: `[${table.name}] Creating primary key: id` });

        if (table.indexes) {
          for (const index of table.indexes) {
            const columnNames = index.columns.map(
              (columnPropertyName) => table.columns[columnPropertyName as string].name
            );
            tableBuilder.index(columnNames, index.name);
            this.logger.info({ message: `[${table.name}] Creating index: ${columnNames}` });
          }
        }
      })
      .catch((reason: any) => {
        reject(`Failed to create table: ${table.name}. reason: ${reason}`);
      })
      .then(() => {
        resolve();
      });

    return p;
  }

  async alterTable(table: Table<any>, tableChanges: TableChanges) {
    let resolve: any;
    let reject: any;
    const p = new Promise<void>((rs, rj) => {
      resolve = rs;
      reject = rj;
    });

    await this.knexDriver
      .getKnex()
      .schema.withSchema(this.knexDriver.getDbName())
      .table(table.name, (tableBuilder: knex.TableBuilder) => {
        for (const columnPropertyName of tableChanges.columnsToCreate) {
          const column = table.columns[columnPropertyName];
          this.logger.info({ message: `[${table.name}] Creating column: ${column.name}` });
          this.createColumn(column, table, tableBuilder, tableChanges);
        }

        for (const column of tableChanges.columnsWithUniqueConstraintsToDrop) {
          tableBuilder.dropUnique([column]);
          this.logger.info({ message: `[${table.name}.${column}] Dropping unique constraint` });
        }

        for (const column of tableChanges.columnsWithForeignKeysToDrop) {
          tableBuilder.dropForeign([column]);
          this.logger.info({ message: `[${table.name}.${column}] Dropping foreign key` });
        }

        for (const index of tableChanges.indexesToDrop) {
          tableBuilder.dropIndex(index.columns);
          this.logger.info({ message: `[${table.name}] Dropping index: ${JSON.stringify(index)}` });
        }

        for (const columnPropertyName of tableChanges.columnsToAlter) {
          const column = table.columns[columnPropertyName];
          this.logger.info({
            message: `[${table.name}.${column.name}] Altering column type to: ${column.constructor.name}`,
          });
          this.createColumn(column, table, tableBuilder, tableChanges).alter();
        }

        for (const columnPropertyName of tableChanges.columnsToRename) {
          const column = table.columns[columnPropertyName];
          if (!column.oldName) {
            continue;
          }

          tableBuilder.renameColumn(column.oldName, column.name);
          this.logger.info({ message: `[${table.name}] Renaming column: ${column.oldName} -> ${column.name}` });
        }

        for (const index of tableChanges.indexesToCreate) {
          tableBuilder.index(index.columns);
          this.logger.info({ message: `[${table.name}] Creating index:`, obj: { index } });
        }
      })
      .catch((reason: any) => {
        reject(`Failed to alter table: ${table.name}. reason: ${reason}`);
      })
      .then(() => {
        resolve();
      });

    return p;
  }

  private createColumn(
    column: Column<any, any>,
    table: Table<any>,
    tableBuilder: knex.TableBuilder,
    tableChanges?: TableChanges
  ) {
    const columnFactory = getColumnFactory(column);
    const columnBuilder = columnFactory.create(column, tableBuilder);
    if (
      column.options?.unique?.unique &&
      (!tableChanges || tableChanges.columnsWithUniqueConstraintsToCreate.includes(column.name))
    ) {
      columnBuilder.unique(column.options.unique.indexName);
      this.logger.info({ message: `[${table.name}.${column.name}] Adding unique constraint` });
    }

    if (
      column.options?.references &&
      (!tableChanges || tableChanges.columnsWithForeignKeysToCreate.includes(column.name))
    ) {
      columnBuilder.references('id').inTable(`${this.knexDriver.getDbName()}.${column.options.references.table}`);
      this.logger.info({
        message: `[${table.name}.${column.name}] Adding foreign key -> ${column.options.references.table}.id`,
      });
    }

    if (typeof column.options?.nullable !== 'undefined') {
      if (column.options?.nullable) {
        columnBuilder.nullable();
      } else {
        columnBuilder.notNullable();
      }

      this.logger.info({
        message: `[${table.name}.${column.name}] Adding constraint nullable: ${column.options?.nullable}`,
      });
    }

    return columnBuilder;
  }
}
