import { Query } from './services/DbService';
import { Table } from './Table';
import { Record } from './Record';
import { QueryBuilder } from '@proteinjs/db-query';

export class QueryBuilderFactory {
  getQueryBuilder<T extends Record>(table: Table<T>, query?: Query<T>): QueryBuilder<T> {
    const qb = query ? 
      query instanceof QueryBuilder ? 
        query
        :
        QueryBuilder.fromObject<T>(query, table.name)
      :
      new QueryBuilder<T>(table.name)
    ;
    return qb;
  }
}