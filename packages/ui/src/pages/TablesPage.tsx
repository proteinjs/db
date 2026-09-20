import React from 'react';
import {
  FormPage,
  Page,
  TableLoader,
  Table as TableComponent,
  RowWindow,
  BaseTableLoader,
  useFormFactor,
} from '@proteinjs/ui';
import { getTables, getDbService, Table } from '@proteinjs/db';
import { recordTableLinkByName } from './RecordTablePage';
import { adminScrollAffordances } from './adminScrollAffordances';
import { PhoneFullBleed } from './PhoneFullBleed';
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
  component: () => <Tables />,
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
    // Full-bleed: the table takes the rest of the viewport; its own scroll container carries
    // the height.
    return <PhoneFullBleed content='table'>{table}</PhoneFullBleed>;
  }

  return (
    <FormPage>
      <Box sx={{ display: 'flex', flexGrow: 1 }}>
        <Box maxHeight='80vh'>{table}</Box>
      </Box>
    </FormPage>
  );
};
