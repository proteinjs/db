import { Query, QueryBuilder, QueryBuilderFactory, Record, SortCriteria, Table, getDb } from '@proteinjs/db';
import { RowWindow, TableLoader } from '@proteinjs/ui';
import { Debouncer } from '@proteinjs/util';

export class QueryTableLoader<T extends Record> implements TableLoader<T> {
  private rowCountQb?: QueryBuilder<T>;
  private paginationQb?: QueryBuilder<T>;
  constructor(
    private table: Table<T>,
    private query?: Query<T>,
    private sort?: SortCriteria<T>[],
    private debouncer?: Debouncer
  ) {
    // Store separate copies of the query for row count and pagination
    this.rowCountQb = new QueryBuilderFactory().createQueryBuilder(this.table, this.query);
    this.paginationQb = new QueryBuilderFactory().createQueryBuilder(this.table, this.query);
  }

  async load(startIndex: number, endIndex: number): Promise<RowWindow<T>> {
    const executeQuery = async (): Promise<{
      rows: T[];
      totalCount: number;
    }> => {
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
    };

    if (this.debouncer) {
      const debouncer = this.debouncer;
      return new Promise<RowWindow<T>>((resolve) => {
        debouncer.debounce(async () => {
          const result = await executeQuery();
          resolve(result);
        });
      });
    } else {
      return await executeQuery();
    }
  }
}
