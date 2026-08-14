import React from 'react';
import { Page, PageComponentProps } from '@proteinjs/ui';
import { tableByName, Table } from '@proteinjs/db';
import { RecordTable } from '../table/RecordTable';
import { Box, Paper, SxProps, Theme, Typography } from '@mui/material';

export const recordTablePage: Page = {
  name: 'Record Table',
  path: 'record/table',
  auth: {
    allUsers: true,
  },
  // No height override: the app's page container owns viewport height (dvh on mobile —
  // a 100vh pin here clipped the bottom behind mobile browser chrome).
  pageContainerSxProps: (theme: Theme): SxProps => {
    return {
      backgroundColor: theme.palette.background.default,
    };
  },
  component: ({ ...props }) => <DynamicRecordTable {...props} />,
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

    // The error state renders as a plain message — wrapping it in the table's stretched
    // card produced a full-height empty Paper with the text clipped at its edge.
    if (!table) {
      return <Typography sx={{ p: 3, color: 'text.secondary' }}>{errorMessage}</Typography>;
    }

    return (
      <Box sx={{ display: 'flex', flexGrow: 1, justifyContent: 'center', padding: 4 }}>
        <Paper sx={{ maxHeight: '80vh' }}>
          <RecordTable table={table} />
        </Paper>
      </Box>
    );
  }

  return <Table />;
};
