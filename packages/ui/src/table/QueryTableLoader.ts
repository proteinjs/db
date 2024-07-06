import { Query, QueryBuilder, QueryBuilderFactory, Record, SortCriteria, Table, getDb } from '@proteinjs/db';
import { RowWindow, TableLoader } from '@proteinjs/ui';
import { Logger } from '@proteinjs/util';

export class QueryTableLoader<T extends Record> implements TableLoader<T> {
  private rowCountQb?: QueryBuilder<T>;
  private paginationQb?: QueryBuilder<T>;
  reactQueryKeys: TableLoader<T>['reactQueryKeys'];

  /**
   * @param table the table to load rows from
   * @param query the query to apply to the table
   * @param sort the sort constraints to apply to the query
   */
  constructor(
    private table: Table<T>,
    private query?: Query<T>,
    private sort?: SortCriteria<T>[]
  ) {
    // Store separate copies of the query for row count and pagination
    this.rowCountQb = new QueryBuilderFactory().createQueryBuilder(this.table, this.query);
    this.paginationQb = new QueryBuilderFactory().createQueryBuilder(this.table, this.query);
    this.reactQueryKeys = {
      dataKey: this.table.name,
      dataQueryKey: JSON.stringify(this.query),
    };
  }

  async load(startIndex: number, endIndex: number, skipRowCount: boolean = false): Promise<RowWindow<T>> {
    const db = getDb();
    const sort: any = this.sort ? this.sort : [{ field: 'created', desc: true }];

    const qb = new QueryBuilderFactory()
      .createQueryBuilder(this.table, this.paginationQb)
      .sort(sort)
      .paginate({ start: startIndex, end: endIndex });
    const queryPromise = db.query(this.table, qb);

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
