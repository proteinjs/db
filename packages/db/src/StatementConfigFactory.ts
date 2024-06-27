import { StatementConfig } from '@proteinjs/db-query';
import { Table, tableByName } from './Table';
import { DbDriverQueryStatementConfig, DbDriverDmlStatementConfig } from './Db';
import {
  IntegerColumn,
  StringColumn,
  FloatColumn,
  DecimalColumn,
  BooleanColumn,
  DateColumn,
  DateTimeColumn,
  BinaryColumn,
} from './Columns';
import { isInstanceOf } from '@proteinjs/util';

export class StatementConfigFactory {
  private dbName: string;
  private getTable: (tableName: string) => Table<any>;

  constructor(dbName: string, getTable?: (tableName: string) => Table<any>) {
    this.dbName = dbName;
    this.getTable = getTable ? getTable : tableByName;
  }

  private isQueryConfig(config: any): config is DbDriverQueryStatementConfig {
    return 'handleCaseSensitivity' in config;
  }

  getStatementConfig(config: DbDriverQueryStatementConfig | DbDriverDmlStatementConfig): StatementConfig {
    return {
      dbName: config.prefixTablesWithDb ? this.dbName : undefined,
      resolveFieldName: this.getResolveFieldName(),
      useParams: config.useParams,
      useNamedParams: config.useNamedParams,
      getColumnType: this.getColumnType(),
      getDriverColumnType: config.getDriverColumnType,
      ...(this.isQueryConfig(config) && { handleCaseSensitivity: config.handleCaseSensitivity }),
    };
  }

  private getResolveFieldName() {
    return (tableName: string, propertyName: string): string => {
      const table = this.getTable(tableName);
      const column = table.columns[propertyName];
      if (!column) {
        throw new Error(`(${table.name}) Column does not exist for property: ${propertyName}`);
      }

      return column.name;
    };
  }

  /**
   * This function returns the type of a given column in terms of internal, database-agnostic column types.
   * These internal types are designed to adhere to common database practices and are not specific to any particular SQL database.
   *
   * @param {string} tableName The table where the column exists.
   * @param {string} propertyName The name of the column for which the type is being retrieved.
   * @returns The internal, database-agnostic type of the column.
   */
  private getColumnType() {
    return (tableName: string, propertyName: string): string => {
      const table = this.getTable(tableName);
      const column = Object.values(table.columns).find((col) => col.name === propertyName);
      if (!column) {
        throw new Error(`(${table.name}) Column does not exist for property: ${propertyName}`);
      }

      if (isInstanceOf(column, IntegerColumn)) {
        return 'int';
      } else if (isInstanceOf(column, StringColumn)) {
        return 'string';
      } else if (isInstanceOf(column, FloatColumn)) {
        return 'float';
      } else if (isInstanceOf(column, DecimalColumn)) {
        return 'decimal';
      } else if (isInstanceOf(column, BooleanColumn)) {
        return 'boolean';
      } else if (isInstanceOf(column, DateColumn)) {
        return 'date';
      } else if (isInstanceOf(column, DateTimeColumn)) {
        return 'datetime';
      } else if (isInstanceOf(column, BinaryColumn)) {
        return 'binary';
      }

      throw new Error(`(${table.name}) Column type for ${propertyName} is not recognized`);
    };
  }
}
