import { Serializer } from '@proteinjs/serializer';
import { Condition, LogicalGroup, QueryBuilder, SortCriteria } from '@proteinjs/db-query';
import { Db, getDb } from './Db';
import { QueryOptions } from './services/DbService';
import { Table } from './Table';
import { Record } from './Record';

/**
 * A cursor anchor names the last row a window served: the row's value for each effective sort
 * criterion, in criteria order. The final criterion is always the unique `id` axis, so an
 * anchor always identifies exactly one row — ties on the other axes can never blur where the
 * next window starts.
 */
export type CursorAnchor = {
  values: unknown[];
};

export type AnchoredWindow<T> = {
  rows: T[];
  /** Anchor for the window after this one; null = the data set is exhausted. */
  nextAnchor: CursorAnchor | null;
};

/**
 * THE owner of cursor-window paging over a table query — every windowed consumer (the
 * server-side `RecordIterator`, the UI's `QueryCursorLoader`) frames its windows here.
 *
 * Each window builds a FRESH query (builders are mutable) carrying a lexicographic
 * continuation past the anchor row, the effective sort, and `paginate(0, windowSize)` — so
 * rows inserted or deleted while paging can never shift the window frame, the offset-paging
 * drift class (`OFFSET n` frames windows by position; concurrent writes slide unvisited rows
 * into the consumed range or consumed rows back into the next window).
 *
 * The effective sort is the consumer's criteria with a unique `id` tiebreak appended (an
 * explicit `id` criterion ends the list — axes after it can never influence order). Ties on
 * consumer axes therefore continue across window boundaries instead of being skipped by a
 * bare `field < cursor`. Sort axes should be non-null columns: a window whose tail carries a
 * NULL sort value ends paging (a null can't anchor a lexicographic continuation — under a
 * descending sort, null rows collect at the tail). `byValues` sorts cannot be paged by cursor
 * and are rejected.
 *
 * Anchors are plain in-memory values; `encodeAnchor`/`decodeAnchor` (house `Serializer`, so
 * dates/moments survive) turn them into strings for consumers whose cursors must serialize —
 * e.g. react-query page params.
 */
export class CursorWindowPager<T extends Record> {
  private effectiveSort: SortCriteria<T>[];

  /**
   * @param table the table to load windows from
   * @param createQuery factory producing a FRESH conditions-only QueryBuilder per call —
   *   every window builds its own to hang the cursor conditions, sort, and pagination on
   * @param sort the consumer's sort criteria; the effective sort appends the `id` tiebreak.
   *   Omitted/empty = pure `id` order (the complete-iteration default).
   * @param options `db` to ride a specific Db (scoped/system/transactional); defaults to
   *   `getDb()` per window. `queryOptions` pass through to every window query.
   */
  constructor(
    private table: Table<T>,
    private createQuery: () => QueryBuilder<T>,
    sort?: SortCriteria<T>[],
    private options?: { db?: Db; queryOptions?: QueryOptions<T> }
  ) {
    this.effectiveSort = this.normalizeSort(sort ?? []);
  }

  /** Load one window: the first when `anchor` is null, otherwise the rows past the anchor. */
  async loadWindow(anchor: CursorAnchor | null, windowSize: number): Promise<AnchoredWindow<T>> {
    if (windowSize < 1) {
      throw new Error(`Cursor window size must be at least 1 (got ${windowSize})`);
    }

    const qb = this.buildWindowQuery(anchor, windowSize);
    const db = this.options?.db ?? getDb();
    const rows = await db.query(this.table, qb, this.options?.queryOptions);
    return { rows, nextAnchor: this.deriveNextAnchor(rows, windowSize) };
  }

  static encodeAnchor(anchor: CursorAnchor): string {
    return Serializer.serialize(anchor);
  }

  static decodeAnchor(encoded: string): CursorAnchor {
    return Serializer.deserialize(encoded);
  }

  private buildWindowQuery(anchor: CursorAnchor | null, windowSize: number): QueryBuilder<T> {
    const qb = this.createQuery();
    if (anchor) {
      qb.or(this.anchorConditions(anchor));
    }
    return qb.sort(this.effectiveSort).paginate({ start: 0, end: windowSize });
  }

  /**
   * Lexicographic continuation past the anchor row: one disjunct per sort criterion — equal on
   * every earlier criterion, strictly past on this one (`<` descending, `>` ascending). The
   * final `id` disjunct is what walks through ties on the consumer's axes.
   */
  private anchorConditions(anchor: CursorAnchor): Array<Condition<T> | LogicalGroup<T>> {
    return this.effectiveSort.map((criterion, index) => {
      const past: Condition<T> = {
        field: criterion.field,
        operator: criterion.desc ? '<' : '>',
        value: anchor.values[index] as T[keyof T],
      };
      if (index === 0) {
        return past;
      }
      const equals: Condition<T>[] = this.effectiveSort.slice(0, index).map((earlier, i) => ({
        field: earlier.field,
        operator: '=',
        value: anchor.values[i] as T[keyof T],
      }));
      return { operator: 'AND', children: [...equals, past] };
    });
  }

  private deriveNextAnchor(rows: T[], windowSize: number): CursorAnchor | null {
    // A short window means the data set is exhausted; a full one implies more may exist —
    // the next (short or empty) window settles it.
    if (rows.length < windowSize) {
      return null;
    }

    const tail = rows[rows.length - 1] as unknown as { [field: string]: unknown };
    const values = this.effectiveSort.map((criterion) => tail[criterion.field as string]);
    // A null sort value can't anchor a lexicographic continuation; under a descending sort
    // null rows collect at the tail, so the data set's sortable rows are exhausted here.
    if (values.some((value) => value == null)) {
      return null;
    }

    return { values };
  }

  private normalizeSort(sort: SortCriteria<T>[]): SortCriteria<T>[] {
    for (const criterion of sort) {
      if (criterion.byValues && criterion.byValues.length > 0) {
        throw new Error(
          `Cursor windows cannot page a byValues sort (field '${String(criterion.field)}'): a CASE ordering has no comparable cursor axis`
        );
      }
    }

    const idIndex = sort.findIndex((criterion) => criterion.field === 'id');
    if (idIndex >= 0) {
      return sort.slice(0, idIndex + 1);
    }

    return [...sort, { field: 'id' as keyof T, desc: false }];
  }
}
