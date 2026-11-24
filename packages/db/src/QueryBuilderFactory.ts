import { isInstanceOf } from '@proteinjs/util';
import { Query } from './services/DbService';
import { Table } from './Table';
import { Record } from './Record';
import { QueryBuilder } from '@proteinjs/db-query';

export class QueryBuilderFactory {
  getQueryBuilder<T extends Record>(table: Table<T>, query?: Query<T>): QueryBuilder<T> {
    const qb = query
      ? isInstanceOf(query, QueryBuilder)
        ? QueryBuilderFactory.builtFor(table, query as QueryBuilder<T>)
        : QueryBuilder.fromObject<T>(query as T, table.name)
      : new QueryBuilder<T>(table.name);
    return qb;
  }

  createQueryBuilder<T extends Record>(table: Table<T>, query?: Query<T>): QueryBuilder<T> {
    const qb = query
      ? isInstanceOf(query, QueryBuilder)
        ? QueryBuilder.fromQueryBuilder<T>(QueryBuilderFactory.builtFor(table, query as QueryBuilder<T>), table.name)
        : QueryBuilder.fromObject<T>(query as T, table.name)
      : new QueryBuilder<T>(table.name);
    return qb;
  }

  /**
   * A builder is run against the table it was built for. The table handed over with it is the one whose
   * doors were asked and whose column queries are added, so a builder built for another table is refused.
   */
  private static builtFor<T extends Record>(table: Table<T>, qb: QueryBuilder<T>): QueryBuilder<T> {
    if (qb.tableName !== table.name) {
      throw new Error(`A query built for another table cannot be run on table: ${table.name}`);
    }

    return qb;
  }
}
