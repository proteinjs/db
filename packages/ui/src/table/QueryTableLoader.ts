import { Query, QueryBuilderFactory, Record, SortCriteria, Table, getDb } from '@proteinjs/db'
import { RowWindow, TableLoader } from '@proteinjs/ui'

export class QueryTableLoader<T extends Record> implements TableLoader<T> {
  constructor(
    private table: Table<T>,
    private query?: Query<T>,
    private sort?: SortCriteria<T>[]
  ) {}

  async load(startIndex: number, endIndex: number): Promise<RowWindow<T>> {
    const db = getDb();
    const sort: any = this.sort ? this.sort : [{ field: 'created', desc: true }];
    const qb = new QueryBuilderFactory().getQueryBuilder(this.table, this.query)
      .sort(sort)
      .paginate({ start: startIndex, end: endIndex })
    ;
    const queryPromise = db.query(this.table, qb);
    const rowcountQb = new QueryBuilderFactory().getQueryBuilder(this.table, this.query);
    const rowCountPromise = db.getRowCount(this.table, rowcountQb);
    const [rows, totalCount] = await Promise.all([queryPromise, rowCountPromise]);
    return { rows, totalCount };
  }
}