import { isInstanceOf } from '@proteinjs/util';
import { QueryBuilder } from './QueryBuilder';

export interface Statement {
  sql: string;
  params?: any[]; // For Knex
  namedParams?: {
    // For Spanner
    params: Record<string, any>;
    types: Record<string, string>;
  };
}

export interface ParameterizationConfig {
  useParams?: boolean; // Enable parameterization
  useNamedParams?: boolean; // Use named parameters (for Spanner), otherwise use '?' (for Knex)
}

export interface StatementConfig extends ParameterizationConfig {
  dbName?: string;
  resolveFieldName?: (tableName: string, propertyName: string) => string;
  getColumnType?: (tableName: string, columnPropertyName: string) => string;
}

interface Column {
  name: string;
  type: string;
  nullable?: boolean;
}

interface ColumnRename {
  currentName: string;
  newName: string;
}

interface ForeignKey {
  table: string; // table that is referenced
  column: string; // column that is referenced
  referencedByColumn: string; // column the constraint is applied to
}

interface Index {
  name?: string;
  columns: string | string[];
  unique?: boolean;
}

export interface AlterTableParams {
  tableName: string;
  columnsToAdd?: Column[];
  foreignKeysToDrop?: ForeignKey[];
  foreignKeysToAdd?: ForeignKey[];
  columnRenames?: ColumnRename[];
}

export class StatementFactory<T> {
  insert(tableName: string, data: Partial<T>, config: StatementConfig): Statement {
    const paramManager = new StatementParamManager(config);
    const props = Object.keys(data);
    const values = props.map((prop) =>
      paramManager.parameterize(
        data[prop as keyof T],
        config.getColumnType ? config.getColumnType(tableName, prop) : typeof data[prop as keyof T]
      )
    );
    const sql = `INSERT INTO ${config.dbName ? `${config.dbName}.` : ''}${tableName} (${props.join(', ')}) VALUES (${values.join(', ')});`;
    return { sql, ...paramManager.getParams() };
  }

  update(tableName: string, data: Partial<T>, queryBuilder: QueryBuilder<T>, config: StatementConfig): Statement {
    const paramManager = new StatementParamManager(config);
    const props = Object.keys(data);
    const setClauses = props
      .map(
        (prop) =>
          `${prop} = ${paramManager.parameterize(
            data[prop as keyof T],
            config.getColumnType ? config.getColumnType(tableName, prop) : typeof data[prop as keyof T]
          )}`
      )
      .join(', ');
    const whereClause = queryBuilder.toWhereClause(config, paramManager);
    const sql = `UPDATE ${config.dbName ? `${config.dbName}.` : ''}${tableName} SET ${setClauses} ${whereClause.sql};`;
    return { sql, ...paramManager.getParams() };
  }

  delete(tableName: string, queryBuilder: QueryBuilder<T>, config: StatementConfig): Statement {
    const paramManager = new StatementParamManager(config);
    const whereClause = queryBuilder.toWhereClause(config, paramManager);
    const sql = `DELETE FROM ${config.dbName ? `${config.dbName}.` : ''}${tableName} ${whereClause.sql};`;
    return { sql, ...paramManager.getParams() };
  }

  createTable(
    tableName: string,
    columns: Column[],
    primaryKey?: string | string[],
    foreignKeys?: ForeignKey[]
  ): Statement {
    const columnsSql = columns
      .map((column) => `${column.name} ${column.type}${column.nullable === false ? ' NOT NULL' : ''}`)
      .join(', ');
    const primaryKeySql = primaryKey
      ? typeof primaryKey === 'string'
        ? `PRIMARY KEY (${primaryKey})`
        : `PRIMARY KEY (${primaryKey.join(', ')})`
      : '';
    const foreignKeysSql = foreignKeys
      ? foreignKeys
          .map(
            (foreignKey) =>
              `CONSTRAINT ${StatementUtil.getForeignKeyName(tableName, foreignKey)} FOREIGN KEY (${foreignKey.referencedByColumn}) REFERENCES ${foreignKey.table}(${foreignKey.column})`
          )
          .join(', ')
      : '';
    const sql = `
      CREATE TABLE ${tableName} (
        ${columnsSql},
        ${foreignKeysSql}
      ) ${primaryKeySql}`;
    return { sql };
  }

  alterTable({
    tableName,
    columnsToAdd = [],
    foreignKeysToDrop = [],
    foreignKeysToAdd = [],
    columnRenames = [],
  }: AlterTableParams): Statement[] {
    const addColumnsSql = columnsToAdd.map(
      (column) =>
        `ALTER TABLE ${tableName} ADD COLUMN ${column.name} ${column.type}${column.nullable === false ? ' NOT NULL' : ''}`
    );
    const dropForeignKeysSql = foreignKeysToDrop.map((foreignKey) => this.dropForeignKey(tableName, foreignKey).sql);
    const addForeignKeysSql = foreignKeysToAdd.map(
      (foreignKey) =>
        `ALTER TABLE ${tableName} ADD CONSTRAINT ${StatementUtil.getForeignKeyName(tableName, foreignKey)} FOREIGN KEY (${foreignKey.referencedByColumn}) REFERENCES ${foreignKey.table}(${foreignKey.column})`
    );
    const renameColumnsSql = columnRenames.map(
      (rename) => `ALTER TABLE ${tableName} RENAME COLUMN ${rename.currentName} TO ${rename.newName}`
    );
    const sql = [...addColumnsSql, ...dropForeignKeysSql, ...addForeignKeysSql, ...renameColumnsSql];
    return sql.map((sqlPart) => ({ sql: sqlPart }));
  }

  dropForeignKey(tableName: string, foreignKey: ForeignKey): Statement {
    return {
      sql: `ALTER TABLE ${tableName} DROP CONSTRAINT ${StatementUtil.getForeignKeyName(tableName, foreignKey)}`,
    };
  }

  createIndex(index: Index, tableName: string): Statement {
    const sql = `CREATE${index.unique ? ' UNIQUE' : ''} INDEX ${StatementUtil.getIndexName(tableName, index)} ON ${tableName}(${typeof index.columns === 'string' ? index.columns : index.columns.join(', ')})`;
    return { sql };
  }

  dropIndex(index: Index, tableName: string): Statement {
    const sql = `DROP INDEX ${StatementUtil.getIndexName(tableName, index)}`;
    return { sql };
  }
}

export class StatementUtil {
  static getIndexName(tableName: string, index: Index) {
    return index.name
      ? index.name
      : `${tableName}_${typeof index.columns === 'string' ? index.columns : index.columns.join('_')}${index.unique ? '_unique' : ''}`;
  }

  static getForeignKeyName(tableName: string, foreignKey: ForeignKey) {
    return `${tableName}_${foreignKey.referencedByColumn}_to_${foreignKey.table}_${foreignKey.column}_foreign`;
  }
}

export class StatementParamManager {
  private params: any[] = [];
  private paramNames: Record<string, any> = {};
  private paramTypes: Record<string, string> = {};
  private paramCounter = 0;

  constructor(private config: StatementConfig) {}

  /**
   * Process and parameterize values (ie. condition values), including handling subqueries
   */
  parameterize(value: any, valueType: string): string {
    if (isInstanceOf(value, QueryBuilder)) {
      // Generate SQL for the subquery
      const subQuery = value.toSql(this.config);
      if (this.config.useParams) {
        if (this.config.useNamedParams && subQuery.namedParams) {
          // Merge parameters and types from subquery
          for (const key of Object.keys(subQuery.namedParams.params)) {
            const paramName = `param${this.paramCounter++}`;
            this.paramNames[paramName] = subQuery.namedParams.params[key];
            this.paramTypes[paramName] = subQuery.namedParams.types[key];
          }
          return `(${subQuery.sql.slice(0, -1)})`; // Remove the trailing semicolon from subquery SQL
        } else if (subQuery.params) {
          // Append parameters from subquery
          this.params.push(...subQuery.params);
        }
      }
      return `(${subQuery.sql.slice(0, -1)})`; // Subquery SQL for non-parameterized config
    } else if (this.config.useParams) {
      if (this.config.useNamedParams) {
        const paramName = `param${this.paramCounter++}`;
        this.paramNames[paramName] = value;
        this.paramTypes[paramName] = valueType;
        return `@${paramName}`;
      } else {
        this.params.push(value);
        return '?';
      }
    } else {
      // Direct value formatting for non-parameterized queries
      if (value instanceof Date) {
        return value.toISOString();
      }
      return typeof value === 'string' ? `'${value}'` : String(value);
    }
  }

  getParams(): {
    params?: any[];
    namedParams?: {
      params: Record<string, any>;
      types: Record<string, string>;
    };
  } {
    if (this.config.useParams) {
      if (this.config.useNamedParams) {
        return { namedParams: { params: this.paramNames, types: this.paramTypes } };
      } else {
        return { params: this.params };
      }
    }

    return {};
  }
}
