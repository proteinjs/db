import React from 'react';
import { FormPage, Page, TableLoader, Table as TableComponent, RowWindow, BaseTableLoader } from '@proteinjs/ui';
import { getTables, getDbService, Table } from '@proteinjs/db';
import { recordTableLinkByName } from './RecordTablePage';
import { adminScrollAffordances } from './adminScrollAffordances';
import { Box, SxProps, Theme } from '@mui/material';

export const tablesPage: Page = {
  name: 'Tables',
  path: 'tables',
  /**
   * Dev tool: browse every table and its row count. Gated by the abstract 'dev' permission
   * (resolved through the consumer app's PermissionRolesMapping; admin passes as break-glass)
   * instead of the implicit default-admin, so the consumer's dev-role holders can use it.
   * Row-level reads stay enforced server-side per table.
   */
  auth: { permission: 'dev' },
  pageContainerSxProps: (theme: Theme): SxProps => {
    return {
      backgroundColor: theme.palette.background.default,
    };
  },
  component: () => (
    <FormPage>
      <Tables />
    </FormPage>
  ),
};

type TableSummary = {
  name: string;
  rowCount: number;
};

class TableSummaryLoader extends BaseTableLoader<TableSummary> {
  constructor(private tables: Table<any>[]) {
    super();
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
}

const Tables = () => {
  return (
    <Box sx={{ display: 'flex', flexGrow: 1 }}>
      <Box maxHeight='80vh'>
        <TableComponent
          title='Tables'
          columns={['name', 'rowCount']}
          tableLoader={new TableSummaryLoader(getTables())}
          rowOnClick={async (row: TableSummary) => {
            return recordTableLinkByName(row.name);
          }}
          {...adminScrollAffordances}
        />
      </Box>
    </Box>
  );
};
