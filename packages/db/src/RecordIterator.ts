import { Db } from './Db';
import { Table } from './Table';
import { Record } from './Record';
import { Query } from './services/DbService';
import { QueryBuilderFactory } from './QueryBuilderFactory';
import { QueryBuilder } from '@proteinjs/db-query';
import { CursorAnchor, CursorWindowPager } from './CursorWindowPager';

/**
 * Iterate a table query in cursor-anchored windows (`CursorWindowPager`), `windowSize` rows
 * per query. Cursor windows frame on the last row served instead of a positional offset, so
 * rows inserted or deleted while iterating can never skip or duplicate rows — every row that
 * exists throughout the iteration is yielded exactly once.
 *
 * Ordering: the sort criteria on the consumer's query builder become the cursor axes, with a
 * unique `id` tiebreak appended (ties can't skip across window boundaries); with no sort the
 * iteration runs in plain `id` order. Sort axes should be non-null columns — a window whose
 * tail carries a NULL sort value ends the iteration (a null can't anchor a continuation).
 *
 * The caller's query builder is never mutated: every window builds on a fresh copy.
 */
export class RecordIterator<T extends Record> implements AsyncIterable<T> {
  private pager: CursorWindowPager<T>;

  constructor(
    table: Table<T>,
    query: Query<T>,
    private windowSize: number = 10,
    db?: Db
  ) {
    // A fresh copy of the consumer's query; its sort criteria lift off the base (the pager
    // owns ordering — cursor axes and ORDER BY have to agree) and the conditions-only base
    // seeds every window's fresh build.
    const base = new QueryBuilderFactory().createQueryBuilder(table, query);
    const sort = base.removeSortCriteria();
    this.pager = new CursorWindowPager<T>(table, () => QueryBuilder.fromQueryBuilder(base, table.name), sort, { db });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let anchor: CursorAnchor | null = null;
    while (true) {
      const window = await this.pager.loadWindow(anchor, this.windowSize);
      for (const row of window.rows) {
        yield row;
      }

      if (!window.nextAnchor) {
        return;
      }

      anchor = window.nextAnchor;
    }
  }
}
