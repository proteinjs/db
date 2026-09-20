import { Record } from '@proteinjs/db';
import { RowWindow, TableLoader } from '@proteinjs/ui';
import { RecordTableCustomization, RecordTableRowChip } from './RecordTableCustomization';

/**
 * Loads a page of rows TOGETHER WITH its chips: after the wrapped loader answers, the table's
 * customization is asked ONCE for the whole page, and each row carries its chips from then on
 * (under `RowChipTableLoader.ROW_CHIPS`, plain data). Because the chips ride the rows, a row never
 * renders before its chip, and a page served from a query cache shows exactly the chips it loaded
 * with. The page is one load: if the chips cannot be read, the load fails the way a failed row
 * query does — a table never shows rows as chip-less when it could not find out.
 *
 * The wrapper keeps the wrapped loader's query keys, so caching and invalidation are unchanged.
 */
export class RowChipTableLoader<T extends Record> implements TableLoader<T> {
  /** The row property a loaded row's chips ride on. */
  static readonly ROW_CHIPS = '__recordTableRowChips';

  constructor(
    private loader: TableLoader<T>,
    private customization: RecordTableCustomization
  ) {}

  get reactQueryKeys(): TableLoader<T>['reactQueryKeys'] {
    return this.loader.reactQueryKeys;
  }

  /** The chips a loaded row carries (none for a row the customization did not name). */
  static chipsOf(row: Record): RecordTableRowChip[] {
    return ((row as any)[RowChipTableLoader.ROW_CHIPS] as RecordTableRowChip[] | undefined) ?? [];
  }

  async load(startIndex: number, endIndex: number, skipRowCount?: boolean): Promise<RowWindow<T>> {
    const page = await this.loader.load(startIndex, endIndex, skipRowCount);
    if (page.rows.length === 0) {
      return page;
    }

    const chips = await this.customization.getRowChips(page.rows);
    return {
      ...page,
      rows: page.rows.map((row) => {
        const rowChips = chips[row.id];
        return rowChips && rowChips.length > 0 ? { ...row, [RowChipTableLoader.ROW_CHIPS]: rowChips } : row;
      }),
    };
  }
}
