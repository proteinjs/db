import React from 'react'
import { FormPage, Page, PageComponentProps } from '@proteinjs/ui'
import { tableByName, Table } from '@proteinjs/db'
import { RecordTable } from '../table/RecordTable'

export const recordTablePage: Page = {
  name: 'Record Table',
  path: 'record/table',
  auth: {
    allUsers: true,
  },
  component: ({...props}) => (
    <FormPage>
      <DynamicRecordTable {...props} />
    </FormPage>
  )
}

export const recordTableLink = (table: Table<any>) => {
  return `/${recordTablePage.path}?name=${table.name}`;
}

export const recordTableLinkByName = (tableName: string) => {
  return `/${recordTablePage.path}?name=${tableName}`;
}

const DynamicRecordTable = ({ urlParams }: PageComponentProps) => {
  function Table() {
    const tableName = urlParams['name'];
    let table;
    let error;
    if (tableName) {
      try {
        table = tableByName(tableName);
      } catch (error) {
        error = `Table not accessible in UI: ${tableName}`;
      }
    } else {
      error = `Table not provided via the 'name' url param`;
    }

    if (!table) {
      return <div>{ error }</div>;
    }

    return (
      <RecordTable
        table={table}
      />
    );
  }

  return (
    <Table />
  );
}