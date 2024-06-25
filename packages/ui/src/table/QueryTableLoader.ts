import { Query, QueryBuilderFactory, Record, SortCriteria, Table, getDb } from '@proteinjs/db';
import { RowWindow, TableLoader } from '@proteinjs/ui';
import { Debouncer, Logger } from '@proteinjs/util';

export class QueryTableLoader<T extends Record> implements TableLoader<T> {
  private logger = new Logger('QueryTableLoader', 'info', 10000);
  constructor(
    private table: Table<T>,
    private query?: Query<T>,
    private sort?: SortCriteria<T>[],
    private debouncer?: Debouncer
  ) {}

  async load(startIndex: number, endIndex: number): Promise<RowWindow<T>> {
    const db = getDb();
    const sort: any = this.sort ? this.sort : [{ field: 'created', desc: true }];
    // veronica todo: bunching these into a single await possibly created some issues with the query getting built
    // the rowCount query was getting some things from the rows query (pagination and sorting) which it shouldn't have
    // doing it one at a time is technically a performance hit
    const rowcountQb = new QueryBuilderFactory().getQueryBuilder(this.table, this.query);
    // const rowCountPromise = db.getRowCount(this.table, rowcountQb);
    const totalCount = await db.getRowCount(this.table, rowcountQb);

    const qb = new QueryBuilderFactory()
      .getQueryBuilder(this.table, this.query)
      .sort(sort)
      .paginate({ start: startIndex, end: endIndex });
    const rows = await db.query(this.table, qb);
    // const [rows, totalCount] = await Promise.all([queryPromise, rowCountPromise]);
    this.logger.info(`rowCount: ${totalCount}`);
    return { rows, totalCount };
  }
}
