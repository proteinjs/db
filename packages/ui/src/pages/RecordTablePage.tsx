import React from 'react';
import { Page, PageComponentProps, useFormFactor } from '@proteinjs/ui';
import { tableByName, Table } from '@proteinjs/db';
import { RecordTable } from '../table/RecordTable';
import { adminScrollAffordances } from './adminScrollAffordances';
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
  // Phone (founder ruling 2026-08-31): the table takes the FULL mobile view under the shell's
  // chrome — no card, no gutters; rows present as the table's phone card face. Desktop keeps
  // the deliberate house card (admin round 3).
  const { isPhone } = useFormFactor();

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

    if (isPhone) {
      // Full-bleed: the table IS the page below the shell chrome. flex-grow 1 + min-height 0
      // against the shell's flex page column hand the table the rest of the viewport; its own
      // scroll container carries the height (the desktop card's 80vh cap has no place here).
      return (
        <Box
          data-phone-fullbleed
          sx={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0, width: '100%' }}
        >
          <RecordTable table={table} {...adminScrollAffordances} />
        </Box>
      );
    }

    return (
      <Box sx={{ display: 'flex', flexGrow: 1, justifyContent: 'center', padding: 4, minWidth: 0 }}>
        <Paper sx={{ maxHeight: '80vh' }}>
          <RecordTable table={table} {...adminScrollAffordances} />
        </Paper>
      </Box>
    );
  }

  return <Table />;
};
