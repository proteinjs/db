import { CursorWindowPager, QueryBuilder, QueryOptions, Record, SortCriteria, Table } from '@proteinjs/db';
import { CursorLoader, CursorValue, CursorWindow, ReactQueryKeys } from '@proteinjs/ui';

/**
 * `CursorLoader` over the db-owned cursor-window machinery (`CursorWindowPager`): each window
 * carries a lexicographic continuation past the anchor row — the primary sort axes plus a
 * unique `id` tiebreak — and `paginate(0, windowSize)` on a fresh build of the base query, so
 * rows created or removed while paging can never shift the window frame, and ties on the sort
 * axis can never skip or duplicate boundary rows. Cursors are the pager's anchors encoded as
 * strings (house `Serializer`, so dates/moments survive react-query page params).
 *
 * `dataKey` is the table name — table-level invalidation (`useTableMutation`) reaches every
 * cursor query over it; `dataQueryKey` is the serialized query + sort.
 */
export class QueryCursorLoader<T extends Record> implements CursorLoader<T> {
  reactQueryKeys: ReactQueryKeys;
  private pager: CursorWindowPager<T>;

  /**
   * @param table the table to load windows from
   * @param createQuery factory producing a FRESH conditions-only QueryBuilder per call —
   *   builders are mutable, so every window builds its own to hang the cursor conditions,
   *   sort, and pagination on
   * @param sort the sort criteria to apply to every window; the primary criterion is the
   *   cursor axis (the pager appends the `id` tiebreak)
   * @param queryOptions query options passed through to every window query
   */
  constructor(
    table: Table<T>,
    createQuery: () => QueryBuilder<T>,
    sort?: SortCriteria<T>[],
    queryOptions?: QueryOptions<T>
  ) {
    const effectiveSort = sort ? sort : [{ field: 'created' as keyof T, desc: true }];
    this.pager = new CursorWindowPager<T>(table, createQuery, effectiveSort, { queryOptions });
    this.reactQueryKeys = {
      dataKey: table.name,
      dataQueryKey: JSON.stringify({ query: createQuery(), sort: effectiveSort }),
    };
  }

  async loadWindow(cursor: CursorValue | null, windowSize: number): Promise<CursorWindow<T>> {
    const anchor = cursor === null ? null : CursorWindowPager.decodeAnchor(cursor as string);
    const window = await this.pager.loadWindow(anchor, windowSize);
    return {
      rows: window.rows,
      nextCursor: window.nextAnchor ? CursorWindowPager.encodeAnchor(window.nextAnchor) : null,
    };
  }
}
