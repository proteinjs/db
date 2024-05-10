import { StatementConfig } from '@proteinjs/db-query';
import { Table, tableByName } from './Table';
import { DbDriverStatementConfig } from './Db';

export class StatementConfigFactory {
  private dbName: string;
  private getTable: (tableName: string) => Table<any>;

  constructor(dbName: string, getTable?: (tableName: string) => Table<any>) {
    this.dbName = dbName;
    this.getTable = getTable ? getTable : tableByName;
  }

  getStatementConfig(config: DbDriverStatementConfig): StatementConfig {
    return {
      dbName: config.prefixTablesWithDb ? this.dbName : undefined,
      resolveFieldName: this.getResolveFieldName(),
      useParams: config.useParams,
      useNamedParams: config.useNamedParams,
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
}
