import { QueryBuilder, QueryOptions, Record, SortCriteria, Table, getDb } from '@proteinjs/db';
import { CursorLoader, CursorValue, CursorWindow, ReactQueryKeys } from '@proteinjs/ui';

/**
 * `CursorLoader` over the same QueryBuilder machinery as `QueryTableLoader`: each window
 * applies `cursorField < cursor` (`>` for an ascending sort) plus `paginate(0, windowSize)`
 * on a fresh build of the base query, so rows created or removed while paging can never
 * shift the window frame. The cursor field and direction derive from the PRIMARY sort
 * criterion.
 *
 * `dataKey` is the table name — table-level invalidation (`useTableMutation`) reaches every
 * cursor query over it; `dataQueryKey` is the serialized query + sort.
 */
export class QueryCursorLoader<T extends Record> implements CursorLoader<T> {
  reactQueryKeys: ReactQueryKeys;
  private sort: SortCriteria<T>[];

  /**
   * @param table the table to load windows from
   * @param createQuery factory producing a FRESH conditions-only QueryBuilder per call —
   *   builders are mutable, so every window builds its own to hang the cursor condition,
   *   sort, and pagination on
   * @param sort the sort criteria to apply to every window; the primary criterion is the
   *   cursor axis
   * @param queryOptions query options passed through to every window query
   */
  constructor(
    private table: Table<T>,
    private createQuery: () => QueryBuilder<T>,
    sort?: SortCriteria<T>[],
    private queryOptions?: QueryOptions<T>
  ) {
    this.sort = sort ? sort : [{ field: 'created' as keyof T, desc: true }];
    this.reactQueryKeys = {
      dataKey: this.table.name,
      dataQueryKey: JSON.stringify({ query: this.createQuery(), sort: this.sort }),
    };
  }

  async loadWindow(cursor: CursorValue | null, windowSize: number): Promise<CursorWindow<T>> {
    const qb = this.buildWindowQuery(cursor, windowSize);
    const rows = await getDb().query(this.table, qb, this.queryOptions);
    return { rows, nextCursor: this.deriveNextCursor(rows, windowSize) };
  }

  private buildWindowQuery(cursor: CursorValue | null, windowSize: number): QueryBuilder<T> {
    const qb = this.createQuery();
    const primarySort = this.sort[0];
    if (cursor !== null) {
      qb.condition({
        field: primarySort.field,
        operator: primarySort.desc ? '<' : '>',
        value: cursor as T[keyof T],
      });
    }
    return qb.sort(this.sort).paginate({ start: 0, end: windowSize });
  }

  private deriveNextCursor(rows: T[], windowSize: number): CursorValue | null {
    // A short window means the data set is exhausted; a full one implies more may exist —
    // the next (short or empty) window settles it.
    if (rows.length < windowSize) {
      return null;
    }
    // NULL cursor-field rows collect at the tail under the sort, and a null tail can't
    // anchor a cursor: the data set's dated rows are exhausted, so paging stops here.
    const tail = rows[rows.length - 1][this.sort[0].field];
    return tail == null ? null : (tail as unknown as CursorValue);
  }
}
