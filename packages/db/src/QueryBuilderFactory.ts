import { isInstanceOf } from '@proteinjs/util';
import { Query } from './services/DbService';
import { Table } from './Table';
import { Record } from './Record';
import { QueryBuilder } from '@proteinjs/db-query';

export class QueryBuilderFactory {
  getQueryBuilder<T extends Record>(table: Table<T>, query?: Query<T>): QueryBuilder<T> {
    const qb = query
      ? isInstanceOf(query, QueryBuilder)
        ? (query as QueryBuilder<T>)
        : QueryBuilder.fromObject<T>(query as T, table.name)
      : new QueryBuilder<T>(table.name);
    return qb;
  }

  createQueryBuilder<T extends Record>(table: Table<T>, query?: Query<T>): QueryBuilder<T> {
    const qb = query
      ? isInstanceOf(query, QueryBuilder)
        ? QueryBuilder.fromQueryBuilder<T>(query as QueryBuilder<T>, table.name)
        : QueryBuilder.fromObject<T>(query as T, table.name)
      : new QueryBuilder<T>(table.name);
    return qb;
  }
}
