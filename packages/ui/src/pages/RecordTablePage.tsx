import React from 'react';
import { Page, PageComponentProps } from '@proteinjs/ui';
import { tableByName, Table } from '@proteinjs/db';
import { RecordTable } from '../table/RecordTable';
import { Box, Paper, SxProps, Theme } from '@mui/material';

export const recordTablePage: Page = {
  name: 'Record Table',
  path: 'record/table',
  auth: {
    allUsers: true,
  },
  pageContainerSxProps: (theme: Theme): SxProps => {
    return {
      height: '100vh',
      backgroundColor: theme.palette.background.default,
    };
  },
  component: ({ ...props }) => (
    <Box sx={{ display: 'flex', flexGrow: 1, justifyContent: 'center', padding: 4 }}>
      <Paper sx={{ maxHeight: '80vh' }}>
        <DynamicRecordTable {...props} />
      </Paper>
    </Box>
  ),
};

export const recordTableLink = (table: Table<any>) => {
  return `/${recordTablePage.path}?name=${table.name}`;
};

export const recordTableLinkByName = (tableName: string) => {
  return `/${recordTablePage.path}?name=${tableName}`;
};

const DynamicRecordTable = ({ urlParams }: PageComponentProps) => {
  function Table() {
    const tableName = urlParams['name'];
    let table;
    let errorMessage;
    if (tableName) {
      try {
        table = tableByName(tableName);
      } catch (error) {
        errorMessage = `Table not accessible in UI: ${tableName}`;
      }
    } else {
      errorMessage = `Table not provided via the 'name' url param`;
    }

    if (!table) {
      return <div>{errorMessage}</div>;
    }

    return <RecordTable table={table} />;
  }

  return <Table />;
};
