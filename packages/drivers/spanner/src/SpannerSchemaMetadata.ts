import { LiveDeleteRowsOlderThan, ParameterizationConfig, QueryBuilder, SchemaMetadata, Table } from '@proteinjs/db';

export class SpannerSchemaMetadata extends SchemaMetadata {
  async tableExists(table: Table<any>): Promise<boolean> {
    const qb = new QueryBuilder('TABLES').condition({ field: 'TABLE_NAME', operator: '=', value: table.name });
    const generateStatement = (config: ParameterizationConfig) => qb.toSql({ dbName: 'INFORMATION_SCHEMA', ...config });
    const results = await this.dbDriver.runQuery(generateStatement);
    return results.length > 0;
  }

  /**
   * The table's row deletion policy as Spanner reports it: `INFORMATION_SCHEMA.TABLES`'s
   * `ROW_DELETION_POLICY_EXPRESSION`, null on a table that carries none and, on the emulator,
   * `OLDER_THAN(created, INTERVAL 7 DAY)` for one that does (verified against the emulator image,
   * 2026-11; the product's information schema page gives the same form by example,
   * `OLDER_THAN(CreatedAt, INTERVAL 1 DAY)`). A text that does not read as that form is handed back
   * as `unread`, never guessed at: the sync then names it and leaves it as it stands.
   */
  async getDeleteRowsOlderThan(table: Table<any>): Promise<LiveDeleteRowsOlderThan | null> {
    const qb = new QueryBuilder('TABLES').condition({ field: 'TABLE_NAME', operator: '=', value: table.name });
    const generateStatement = (config: ParameterizationConfig) => qb.toSql({ dbName: 'INFORMATION_SCHEMA', ...config });
    const results = await this.dbDriver.runQuery(generateStatement);
    const expression = results[0]?.['ROW_DELETION_POLICY_EXPRESSION'];
    if (typeof expression !== 'string' || expression.trim().length === 0) {
      return null;
    }

    const olderThan = /^\s*OLDER_THAN\s*\(\s*`?([A-Za-z_][A-Za-z0-9_]*)`?\s*,\s*INTERVAL\s+(\d+)\s+DAY\s*\)\s*$/i.exec(
      expression
    );
    return olderThan ? { column: olderThan[1], days: Number(olderThan[2]) } : { unread: expression };
  }

  async getColumnMetadata(table: Table<any>): Promise<{ [columnName: string]: { type: string; isNullable: boolean } }> {
    const qb = QueryBuilder.fromObject(
      {
        TABLE_NAME: table.name,
      },
      'COLUMNS'
    );
    const generateStatement = (config: ParameterizationConfig) => qb.toSql({ dbName: 'INFORMATION_SCHEMA', ...config });
    const results = await this.dbDriver.runQuery(generateStatement);
    const columnMetadata: { [columnName: string]: { type: string; isNullable: boolean } } = {};
    for (const row of results) {
      columnMetadata[row['COLUMN_NAME']] = { type: row['SPANNER_TYPE'], isNullable: row['IS_NULLABLE'] === 'YES' };
    }

    return columnMetadata;
  }

  async getPrimaryKey(table: Table<any>): Promise<string[]> {
    const indexes = await this.getIndexes(table);
    return indexes['PRIMARY_KEY'];
  }

  async getForeignKeys(
    table: Table<any>
  ): Promise<{ [columnName: string]: { referencedTableName: string; referencedColumnName: string } }> {
    const tableConstraintsQb = QueryBuilder.fromObject(
      {
        TABLE_NAME: table.name,
        CONSTRAINT_TYPE: 'FOREIGN KEY',
      },
      'TABLE_CONSTRAINTS'
    );
    const generateTableConstraintsStatement = (config: ParameterizationConfig) =>
      tableConstraintsQb.toSql({ dbName: 'INFORMATION_SCHEMA', ...config });
    const tableConstraints = await this.dbDriver.runQuery(generateTableConstraintsStatement);
    const foreignKeys: { [columnName: string]: { referencedTableName: string; referencedColumnName: string } } = {};
    for (const tableConstraint of tableConstraints) {
      const referentialConstraintsQb = QueryBuilder.fromObject(
        {
          CONSTRAINT_NAME: tableConstraint['CONSTRAINT_NAME'],
        },
        'REFERENTIAL_CONSTRAINTS'
      );
      const generateReferentialConstraintsStatement = (config: ParameterizationConfig) =>
        referentialConstraintsQb.toSql({ dbName: 'INFORMATION_SCHEMA', ...config });
      const referentialConstraints = await this.dbDriver.runQuery(generateReferentialConstraintsStatement);
      const referencedTableConstraintName = referentialConstraints[0]['UNIQUE_CONSTRAINT_NAME'];

      const referenceTableConstraintsQb = QueryBuilder.fromObject(
        {
          CONSTRAINT_NAME: referencedTableConstraintName,
        },
        'TABLE_CONSTRAINTS'
      );
      const generateReferenceTableConstraintsStatement = (config: ParameterizationConfig) =>
        referenceTableConstraintsQb.toSql({ dbName: 'INFORMATION_SCHEMA', ...config });
      const referenceTableConstraints = await this.dbDriver.runQuery(generateReferenceTableConstraintsStatement);
      const referencedTableName = referenceTableConstraints[0]['TABLE_NAME'];

      const keyColumnUsageQb = QueryBuilder.fromObject(
        {
          TABLE_NAME: table.name,
          CONSTRAINT_NAME: tableConstraint['CONSTRAINT_NAME'],
        },
        'KEY_COLUMN_USAGE'
      );
      const generateKeyColumnUsageStatement = (config: ParameterizationConfig) =>
        keyColumnUsageQb.toSql({ dbName: 'INFORMATION_SCHEMA', ...config });
      const keyColumnUsages = await this.dbDriver.runQuery(generateKeyColumnUsageStatement);
      const referencingColumnName = keyColumnUsages[0]['COLUMN_NAME'];

      foreignKeys[referencingColumnName] = {
        referencedTableName,
        referencedColumnName: 'id',
      };
    }

    return foreignKeys;
  }

  async getUniqueColumns(table: Table<any>): Promise<string[]> {
    const indexes = await this.getIndexes(table);
    const uniqueColumns: string[] = [];
    for (const indexName in indexes) {
      if (!indexName.endsWith('_unique')) {
        continue;
      }

      const indexedColumns = indexes[indexName];
      uniqueColumns.push(...indexedColumns);
    }

    return uniqueColumns;
  }

  async getIndexes(table: Table<any>): Promise<{ [keyName: string]: string[] }> {
    const qb = new QueryBuilder('INDEX_COLUMNS')
      .condition({ field: 'TABLE_NAME', operator: '=', value: table.name })
      .sort([{ field: 'ORDINAL_POSITION', desc: false }]);
    const generateStatement = (config: ParameterizationConfig) => qb.toSql({ dbName: 'INFORMATION_SCHEMA', ...config });
    const results: any[] = await this.dbDriver.runQuery(generateStatement);
    const indexes: { [keyName: string]: string[] } = {};
    for (const row of results) {
      if (!row['INDEX_NAME']) {
        continue;
      }

      if (!indexes[row['INDEX_NAME']]) {
        indexes[row['INDEX_NAME']] = [];
      }

      indexes[row['INDEX_NAME']].push(row['COLUMN_NAME']);
    }

    return indexes;
  }
}
