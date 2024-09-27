import React from 'react';
import { FormPage, Page, TableLoader, Table as TableComponent, RowWindow, BaseTableLoader } from '@proteinjs/ui';
import { getTables, getDbService, Table } from '@proteinjs/db';
import { recordTableLinkByName } from './RecordTablePage';
import { Box, SxProps, Theme } from '@mui/material';

export const tablesPage: Page = {
  name: 'Tables',
  path: 'tables',
  pageContainerSxProps: (theme: Theme): SxProps => {
    return {
      height: '100vh',
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
        />
      </Box>
    </Box>
  );
};
