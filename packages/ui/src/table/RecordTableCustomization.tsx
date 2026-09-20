import React from 'react';
import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { Record, Table } from '@proteinjs/db';

export const getRecordTableCustomizations = () =>
  SourceRepository.get().objects<RecordTableCustomization>('@proteinjs/db-ui/RecordTableCustomization');

export const getRecordTableCustomization = (tableName: string) => {
  for (const recordTableCustomization of getRecordTableCustomizations()) {
    if (recordTableCustomization.table.name == tableName) {
      return recordTableCustomization;
    }
  }
};

/**
 * A quiet chip a row wears after its identity (the first column's value): a fact about the record
 * that the table's own columns cannot say, because it lives somewhere else.
 */
export type RecordTableRowChip = {
  /** The word the chip shows. */
  label: string;
  /** Names the chip to the customization's own `getChipIcon`; plain data, like the label. */
  kind?: string;
};

/** The chips of one loaded page, by record id. A row absent from the map wears none. */
export type RecordTableRowChips = { [recordId: string]: RecordTableRowChip[] };

/**
 * The table twin of `RecordFormCustomization`: a Loadable that names its table and adds to what
 * the record table shows for it.
 *
 * Row chips are asked for ONCE PER LOADED PAGE — `getRowChips` receives every row of the page and
 * answers for all of them in one call, so a customization backed by a service makes one request
 * per page, never one per row. The answer travels WITH the page: the rows and their chips arrive
 * together (a row never renders first and gains its chip later), and a cached page keeps the chips
 * it loaded with. Chips are plain data; how a chip looks is the record table's, and an icon, when
 * a customization wants one, is supplied at render time through `getChipIcon`.
 */
export abstract class RecordTableCustomization implements Loadable {
  abstract table: Table<any>;

  /** The chips for one loaded page of rows, keyed by record id. Called once per page load. */
  abstract getRowChips(rows: Record[]): Promise<RecordTableRowChips>;

  /** A small leading icon for a chip (sized by the chip: 12px, the chip's own ink). */
  getChipIcon(chip: RecordTableRowChip): React.ReactNode | undefined {
    return undefined;
  }
}
