import React from 'react';
import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { Identity, Record, Table, TableAuth } from '@proteinjs/db';

/**
 * What a declared panel's component receives. The panel OWNS its presentation: it renders off the
 * loaded record and its own first-paint `data` (its `load()` result), and asks the page to
 * `reload` when something it wrote should show — the record and every panel's data re-read
 * together, so the surface never shows a fresh panel beside a stale form.
 */
export type RecordPanelProps<T extends Record = any, D = any> = {
  table: Table<T>;
  /** The loaded record — panels are consulted only for existing records, never on create. */
  record: T;
  /** The panel's own first-paint data (its `load()` result), awaited by the page with the record. */
  data: D;
  /** Re-read the record AND every panel's data through the page's one loader, then re-render. */
  reload: () => Promise<void>;
};

export type RecordPanelRenderer<T extends Record = any, D = any> = React.ComponentType<RecordPanelProps<T, D>>;

/**
 * A related presentation DECLARED for a table's record form (plans/USAGE_SURFACES.md §B.1) —
 * "look at a user record and see their usage". Resolved by reflection like
 * `RecordFormCustomization`, but MANY per table: a package that does not own the table's
 * customization can still contribute a panel (thought-ui could add "their thoughts" to the user
 * record without touching app-ui). Each panel carries its own grant gate and its own loader; the
 * page awaits every visible panel's `load()` alongside the record fetch and paints the form and
 * its panels together — complete, never a spinner beside a form.
 *
 * Placement is derived, not configured: at `theme.breakpoints.lg` and wider the panels sit in a
 * column BESIDE the form; narrower (and on phones) they STACK BELOW it in the same scroll. The
 * form itself renders byte-identical with or without panels. Actions do not ride this seam —
 * `RecordFormCustomization.getFormButtons` owns them; a panel may carry its own doors inside its
 * component.
 */
export abstract class RecordPanel<T extends Record = any, D = any> implements Loadable {
  abstract table: Table<T>;
  /** Stable key — view state, tests, deep links. */
  abstract name: string;
  /** The section label, an everyday word ("Usage"). */
  abstract title: string;
  /**
   * Who sees it — the `Table.auth` Identity vocabulary ('public' | 'authenticated' | roles[] |
   * { permission }). Undeclared → the table's `auth.ui.recordForm` if declared, else admin-only
   * (default-deny). This gate is a UI affordance; the panel's DATA door is its own service.
   */
  auth?: Identity;
  /** Ordering among this table's panels (then by name). */
  order = 100;
  /**
   * First-paint data. The page awaits every visible panel's `load()` alongside the record fetch
   * and paints form and panels together. A slow panel delays the page — correct for an admin
   * surface; a panel whose full data is genuinely expensive loads a complete-with-less summary,
   * never a spinner. A panel whose load REJECTS does not paint (the page logs it): no half-panel.
   */
  abstract load(record: T): Promise<D>;
  abstract component: RecordPanelRenderer<T, D>;
}

export const getRecordPanelDeclarations = () =>
  SourceRepository.get().objects<RecordPanel>('@proteinjs/db-ui/RecordPanel');

/**
 * The panels the CURRENT user sees on this table's record form: every declared panel for the
 * table (all matches, unlike the one-per-table customization), filtered by each panel's identity
 * gate, in declared order (then by name).
 */
export const getRecordPanels = (
  tableName: string,
  declarations: RecordPanel[] = getRecordPanelDeclarations()
): RecordPanel[] => {
  const tableAuth = new TableAuth();
  return declarations
    .filter((panel) => panel.table.name === tableName)
    .filter((panel) => tableAuth.identityAllows(panel.auth ?? panel.table.auth?.ui?.recordForm))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
};
