import React from 'react';
import { FormPage, Page, Table as TableComponent, RowWindow, BaseTableLoader, useFormFactor } from '@proteinjs/ui';
import { getTables, getDbService, Table, TableAuth } from '@proteinjs/db';
import { recordTableLinkByName } from './RecordTablePage';
import { adminScrollAffordances } from './adminScrollAffordances';
import { Box, SxProps, Theme } from '@mui/material';

export const tablesPage: Page = {
  name: 'Tables',
  path: 'tables',
  /**
   * Dev tool: browse every table the viewer may query and its row count. Gated by the abstract
   * 'dev' permission (resolved through the consumer app's PermissionRolesMapping; admin passes as
   * break-glass) instead of the implicit default-admin, so the consumer's dev-role holders can use
   * it. The list holds only the tables whose query door the viewer clears (TableSummaryLoader);
   * row-level reads stay enforced server-side per table.
   */
  auth: { permission: 'dev' },
  pageContainerSxProps: (theme: Theme): SxProps => {
    return {
      backgroundColor: theme.palette.background.default,
    };
  },
  component: () => <Tables />,
};

type TableSummary = {
  name: string;
  rowCount: number;
};

/**
 * Each row is a count the DbService RPC answers, so the loader lists only the tables the viewer may
 * query through the service, as their owner answers (`TableAuth.canPerformThroughService`: the
 * service gate and the inner Db's db-api re-check), before it windows or counts any — a table
 * nobody may read through the service (a declared `query: []`, the admin included) has no row, and
 * a count that fails for any other reason still fails the window.
 */
class TableSummaryLoader extends BaseTableLoader<TableSummary> {
  private tables: Table<any>[];

  constructor(tables: Table<any>[]) {
    super();
    this.tables = this.queryable(tables);
  }

  async load(startIndex: number, endIndex: number) {
    const page: RowWindow<TableSummary> = { rows: [], totalCount: this.tables.length };
    const tables = this.tables.slice(startIndex, endIndex);
    const dbService = getDbService();
    for (const table of tables) {
      const rowCount = await dbService.getRowCount(table);
      page.rows.push({ name: table.name, rowCount });
    }

    return page;
  }

  /** The tables the viewer may query through the service, the road the count takes. */
  private queryable(tables: Table<any>[]): Table<any>[] {
    const tableAuth = new TableAuth();
    return tables.filter((table) => tableAuth.canPerformThroughService(table, 'query'));
  }
}

const Tables = () => {
  // Phone (founder ruling 2026-08-31): the table takes the FULL mobile view under the shell's
  // chrome — no FormPage card, no gutters. Desktop keeps the house FormPage card.
  const { isPhone } = useFormFactor();

  const table = (
    <TableComponent
      title='Tables'
      columns={['name', 'rowCount']}
      tableLoader={new TableSummaryLoader(getTables())}
      rowOnClick={async (row: TableSummary) => {
        return recordTableLinkByName(row.name);
      }}
      {...adminScrollAffordances}
    />
  );

  if (isPhone) {
    // Full-bleed: flex-grow 1 + min-height 0 against the shell's flex page column hand the
    // table the rest of the viewport; its own scroll container carries the height.
    return (
      <Box
        data-phone-fullbleed
        sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0, width: '100%' }}
      >
        {table}
      </Box>
    );
  }

  return (
    <FormPage>
      <Box sx={{ display: 'flex', flexGrow: 1 }}>
        <Box maxHeight='80vh'>{table}</Box>
      </Box>
    </FormPage>
  );
};
