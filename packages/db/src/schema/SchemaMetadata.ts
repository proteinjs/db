import { ParameterizationConfig, QueryBuilder } from '@proteinjs/db-query';
import { Table } from '../Table';
import { DbDriver } from '../Db';

export class SchemaMetadata {
  constructor(
    public dbDriver: DbDriver,
    private multiDbSupported = true
  ){}

  async tableExists(table: Table<any>): Promise<boolean> {
		const qb = new QueryBuilder('TABLES').condition({ field: 'TABLE_NAME', operator: '=', value: table.name });
		const generateStatement = (config: ParameterizationConfig) => qb.toSql({ dbName: 'INFORMATION_SCHEMA', ...config });
		const results = await this.dbDriver.runQuery(generateStatement);
		return results.length > 0;
	}

  async columnExists(columnName: string, table: Table<any>): Promise<boolean> {
    const qb = QueryBuilder.fromObject({
      'TABLE_SCHEMA': this.multiDbSupported ? this.dbDriver.getDbName() : undefined,
      'TABLE_NAME': table.name,
      'COLUMN_NAME': columnName,
    }, 'COLUMNS');
		const generateStatement = (config: ParameterizationConfig) => qb.toSql({ dbName: 'INFORMATION_SCHEMA', ...config });
		const results = await this.dbDriver.runQuery(generateStatement);
		return results.length > 0;
  }
  
  async getColumnMetadata(table: Table<any>): Promise<{[columnName: string]: { type: string, isNullable: boolean }}> {
    const qb = QueryBuilder.fromObject({
      'TABLE_SCHEMA': this.multiDbSupported ? this.dbDriver.getDbName() : undefined,
      'TABLE_NAME': table.name
    }, 'COLUMNS');
    const generateStatement = (config: ParameterizationConfig) => qb.toSql({ dbName: 'INFORMATION_SCHEMA', ...config });
		const results = await this.dbDriver.runQuery(generateStatement);
    const columnMetadata: {[columnName: string]: { type: string, isNullable: boolean }} = {};
    for (const row of results)
      columnMetadata[row['COLUMN_NAME']] = { type: row['DATA_TYPE'], isNullable: row['IS_NULLABLE'] === 'YES' };
  
    return columnMetadata;
  }
  
  async getPrimaryKey(table: Table<any>): Promise<string[]> {
    const qb = QueryBuilder.fromObject({
      'TABLE_SCHEMA': this.multiDbSupported ? this.dbDriver.getDbName() : undefined,
      'TABLE_NAME': table.name,
      'CONSTRAINT_NAME': 'PRIMARY',
    }, 'KEY_COLUMN_USAGE');
    const generateStatement = (config: ParameterizationConfig) => qb.toSql({ dbName: 'INFORMATION_SCHEMA' });
		const results = await this.dbDriver.runQuery(generateStatement);
    const primaryKey: string[] = [];
    for (const row of results)
      primaryKey.push(row['COLUMN_NAME']);
  
    return primaryKey;
  }
  
  async getForeignKeys(table: Table<any>): Promise<{[columnName: string]: { referencedTableName: string, referencedColumnName: string }}> {
    const qb = QueryBuilder.fromObject({
      'TABLE_SCHEMA': this.multiDbSupported ? this.dbDriver.getDbName() : undefined,
      'TABLE_NAME': table.name
    }, 'KEY_COLUMN_USAGE');
    const generateStatement = (config: ParameterizationConfig) => qb.toSql({ dbName: 'INFORMATION_SCHEMA', ...config });
		const results = await this.dbDriver.runQuery(generateStatement);
    const foreignKeys: {[columnName: string]: { referencedTableName: string, referencedColumnName: string }} = {};
    for (const row of results) {
      if (!row['REFERENCED_TABLE_NAME'])
        continue;
  
      foreignKeys[row['COLUMN_NAME']] = {
        referencedTableName: row['REFERENCED_TABLE_NAME'],
        referencedColumnName: row['REFERENCED_COLUMN_NAME'],
      };
    }
  
    return foreignKeys;
  }
  
  async getUniqueColumns(table: Table<any>): Promise<string[]> {
    const qb = QueryBuilder.fromObject({
      'TABLE_SCHEMA': this.multiDbSupported ? this.dbDriver.getDbName() : undefined,
      'TABLE_NAME': table.name
    }, 'KEY_COLUMN_USAGE');
    const generateStatement = (config: ParameterizationConfig) => qb.toSql({ dbName: 'INFORMATION_SCHEMA', ...config });
		const results = await this.dbDriver.runQuery(generateStatement);
    const uniqueColumns: string[] = [];
    for (const row of results) {
      if (!(row['CONSTRAINT_NAME'] as string).endsWith('_unique'))
        continue;
  
      uniqueColumns.push(row['COLUMN_NAME']);
    }
  
    return uniqueColumns;
  }
  
  async getIndexes(table: Table<any>): Promise<{[keyName: string]: string[]}> {
    const qb = new QueryBuilder('STATISTICS')
      .condition({ field: 'TABLE_SCHEMA', operator: '=', value: this.dbDriver.getDbName() })
      .condition({ field: 'TABLE_NAME', operator: '=', value: table.name })
      .sort([{ field: 'SEQ_IN_INDEX', desc: false }])
    ;
    const generateStatement = (config: ParameterizationConfig) => qb.toSql({ dbName: 'INFORMATION_SCHEMA', ...config });
		const results: any[] = await this.dbDriver.runQuery(generateStatement);
    const indexes: { [keyName: string]: string[] } = {};
    for (const row of results) {
      if (!indexes[row['INDEX_NAME']])
        indexes[row['INDEX_NAME']] = [];
  
      indexes[row['INDEX_NAME']].push(row['COLUMN_NAME']);
    }
  
    return indexes;
  }
}