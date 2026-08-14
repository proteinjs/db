import React from 'react';
import { FormPage, Page, PageComponentProps } from '@proteinjs/ui';
import { getDbService, tableByName } from '@proteinjs/db';
import { RecordForm } from '../form/RecordForm';
import { Theme, SxProps, Typography } from '@mui/material';

export const recordFormPage: Page = {
  name: 'Record Form',
  path: 'record/form',
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
  component: ({ ...props }) => (
    <FormPage>
      <DynamicRecordForm {...props} />
    </FormPage>
  ),
};

export const recordFormLink = (tableName: string, recordId: string) => {
  return `/${recordFormPage.path}?table=${tableName}&record=${recordId}`;
};

export const newRecordFormLink = (tableName: string) => {
  return `/${recordFormPage.path}?table=${tableName}`;
};

const DynamicRecordForm = ({ urlParams }: PageComponentProps) => {
  const recordId = urlParams['record'];
  const [record, setRecord] = React.useState();
  /**
   * The form renders differently for a new record than for an existing one (RecordFormCustomization
   * keys its buttons and fields off `record`), so an existing record must not be rendered until it
   * has loaded — otherwise the form briefly shows the create surface for a record that already
   * exists. New-record forms have nothing to wait for and start loaded.
   */
  const [recordLoaded, setRecordLoaded] = React.useState(!recordId);
  const [loadError, setLoadError] = React.useState<string>();

  React.useEffect(() => {
    const fetchData = async () => {
      const { table } = getTable();
      if (!table || !recordId) {
        return;
      }

      setRecordLoaded(false);
      setLoadError(undefined);
      try {
        const fetchedRecord = await getDbService().get(table, { id: recordId });
        setRecord(fetchedRecord);
      } catch {
        setLoadError(`Unable to load ${table.name} record: ${recordId}`);
      }
      setRecordLoaded(true);
    };

    fetchData();
  }, [urlParams.table, urlParams.record]);

  function getTable() {
    const tableName = urlParams['table'];
    let table;
    let error;
    if (tableName) {
      try {
        table = tableByName(tableName);
      } catch {
        // NOTE: this catch previously bound the exception as `error`, shadowing the outer
        // variable — the message was never returned and the page rendered blank.
        error = `Table not accessible in UI: ${tableName}`;
      }
    } else {
      error = `Table name not provided via the 'table' url param`;
    }

    return { table, error };
  }

  function Message({ children }: { children: React.ReactNode }) {
    return <Typography sx={{ p: 3, color: 'text.secondary' }}>{children}</Typography>;
  }

  function Form() {
    const { table, error } = getTable();
    if (!table) {
      return <Message>{error}</Message>;
    }

    if (loadError) {
      return <Message>{loadError}</Message>;
    }

    if (!recordLoaded) {
      return null;
    }

    if (recordId && !record) {
      return <Message>{`No ${table.name} record found: ${recordId}`}</Message>;
    }

    return <RecordForm table={table} record={record} />;
  }

  return <Form />;
};
