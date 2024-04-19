import React from 'react'
import { FormPage, Page, TableLoader, Table as TableComponent, RowWindow } from '@proteinjs/ui'
import { getTables, getDbService, Table } from '@proteinjs/db'
import { recordTableLinkByName } from './RecordTablePage'

export const tablesPage: Page = {
  name: 'Tables',
  path: 'tables',
  component: () => (
    <FormPage>
      <Tables />
    </FormPage>
  )
}

type TableSummary = {
  name: string,
  rowCount: number,
}

class TableSummaryLoader implements TableLoader<TableSummary> {
  constructor(private tables: Table<any>[]) {}

  async load(startIndex: number, endIndex: number) {
    const page: RowWindow<TableSummary> = { rows: [], totalCount: this.tables.length };
    const tables = this.tables.slice(startIndex, endIndex);
    const dbService = getDbService();
    for (let table of tables) {
      const rowCount = await dbService.getRowCount(table);
      page.rows.push({ name: table.name, rowCount });
    }

    return page;
  }
}

const Tables = () => {
  return (
    <TableComponent
      title='Tables'
      columns={['name', 'rowCount']}
      tableLoader={new TableSummaryLoader(getTables())}
      rowOnClickRedirectUrl={async (row: TableSummary) => {
        return recordTableLinkByName(row.name);
      }}
    />
  );
}