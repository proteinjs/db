import {
  Query,
  QueryBuilder,
  QueryBuilderFactory,
  QueryOptions,
  Record,
  SortCriteria,
  Table,
  getDb,
} from '@proteinjs/db';
import { RowWindow, TableLoader } from '@proteinjs/ui';

/**
 * `TableLoader` over a table query: a page is the query's rows under the sort, offset-paginated.
 *
 * `dataKey` is the table name — table-level invalidation (`useTableMutation`) reaches every
 * cached page over it; `dataQueryKey` is the serialized query + sort (the same identity
 * `QueryCursorLoader` carries). The sort is part of what a page IS: keyed on the query alone, a
 * loader under a different sort named the same cached pages — a changed sort fetched nothing and
 * the previous sort's rows stood in for it.
 */
export class QueryTableLoader<T extends Record> implements TableLoader<T> {
  private rowCountQb?: QueryBuilder<T>;
  private paginationQb?: QueryBuilder<T>;
  private effectiveSort: SortCriteria<T>[];
  reactQueryKeys: TableLoader<T>['reactQueryKeys'];

  /**
   * @param table the table to load rows from
   * @param query the query to apply to the table
   * @param sort the sort constraints to apply to the query
   */
  constructor(
    private table: Table<T>,
    private query?: Query<T>,
    sort?: SortCriteria<T>[],
    private queryOptions?: QueryOptions<T>
  ) {
    // Store separate copies of the query for row count and pagination
    this.rowCountQb = new QueryBuilderFactory().createQueryBuilder(this.table, this.query);
    this.paginationQb = new QueryBuilderFactory().createQueryBuilder(this.table, this.query);
    this.effectiveSort = sort ? sort : [{ field: 'created' as keyof T, desc: true }];
    this.reactQueryKeys = {
      dataKey: this.table.name,
      dataQueryKey: JSON.stringify({ query: this.query, sort: this.effectiveSort }),
    };
  }

  async load(startIndex: number, endIndex: number, skipRowCount: boolean = false): Promise<RowWindow<T>> {
    const db = getDb();

    const qb = new QueryBuilderFactory()
      .createQueryBuilder(this.table, this.paginationQb)
      .sort(this.effectiveSort)
      .paginate({ start: startIndex, end: endIndex });
    const queryPromise = db.query(this.table, qb, this.queryOptions);

    if (skipRowCount) {
      const rows = await queryPromise;
      return { rows, totalCount: 0 };
    } else {
      const rowCountPromise = db.getRowCount(this.table, this.rowCountQb);
      const [rows, totalCount] = await Promise.all([queryPromise, rowCountPromise]);
      return { rows, totalCount };
    }
  }
}
