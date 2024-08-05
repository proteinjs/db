import { Db, getDb } from './Db';
import { Table } from './Table';
import { Record } from './Record';
import { Query } from './services/DbService';
import { QueryBuilderFactory } from './QueryBuilderFactory';
import { QueryBuilder } from '@proteinjs/db-query';

export class RecordIterator<T extends Record> implements AsyncIterable<T> {
  private db: Db;
  private table: Table<T>;
  private query: QueryBuilder<T>;
  private pageSize: number;
  private currentPage: number;

  constructor(table: Table<T>, query: Query<T>, pageSize: number = 10) {
    this.db = getDb();
    this.table = table;
    this.query = new QueryBuilderFactory().getQueryBuilder(table, query);
    this.pageSize = pageSize;
    this.currentPage = 0;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const pagination = { start: this.currentPage * this.pageSize, end: (this.currentPage + 1) * this.pageSize };
      this.query.paginate(pagination);
      const results = await this.db.query(this.table, this.query);

      if (results.length === 0) {
        return;
      }

      for (const item of results) {
        yield item;
      }

      if (results.length < this.pageSize) {
        return;
      }

      this.currentPage++;
    }
  }
}
