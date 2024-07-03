import { Query, QueryBuilder, QueryBuilderFactory, Record, SortCriteria, Table, getDb } from '@proteinjs/db';
import { RowWindow, TableLoader } from '@proteinjs/ui';
import { Logger } from '@proteinjs/util';

export class QueryTableLoader<T extends Record> implements TableLoader<T> {
  private rowCountQb?: QueryBuilder<T>;
  private paginationQb?: QueryBuilder<T>;

  reactQueryKeys: {
    dataKey: string;
    dataQueryKey: string;
    rowKey: string;
  };

  /**
   * @param table the table to load rows from
   * @param dataQueryKey a unique name to identify this query for cache invalidation (required for react-query)
   * @param query the query to apply to the table
   * @param sort the sort constraints to apply to the query
   */
  constructor(
    private table: Table<T>,
    dataQueryKey: string,
    private query?: Query<T>,
    private sort?: SortCriteria<T>[]
  ) {
    // Store separate copies of the query for row count and pagination
    this.rowCountQb = new QueryBuilderFactory().createQueryBuilder(this.table, this.query);
    this.paginationQb = new QueryBuilderFactory().createQueryBuilder(this.table, this.query);
    this.reactQueryKeys = {
      dataKey: table.name,
      dataQueryKey,
      rowKey: 'id',
    };
  }

  async load(startIndex: number, endIndex: number): Promise<RowWindow<T>> {
    const db = getDb();
    const sort: any = this.sort ? this.sort : [{ field: 'created', desc: true }];

    const rowCountPromise = db.getRowCount(this.table, this.rowCountQb);
    const qb = new QueryBuilderFactory()
      .createQueryBuilder(this.table, this.paginationQb)
      .sort(sort)
      .paginate({ start: startIndex, end: endIndex });
    const queryPromise = db.query(this.table, qb);

    const [rows, totalCount] = await Promise.all([queryPromise, rowCountPromise]);
    return { rows, totalCount };
  }
}
