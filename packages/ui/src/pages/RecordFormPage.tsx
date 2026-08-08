import React from 'react';
import { FormPage, Page, PageComponentProps } from '@proteinjs/ui';
import { getDbService, tableByName } from '@proteinjs/db';
import { RecordForm } from '../form/RecordForm';
import { Theme, SxProps } from '@mui/material';

export const recordFormPage: Page = {
  name: 'Record Form',
  path: 'record/form',
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
      } catch (error) {
        // eslint-disable-next-line no-ex-assign
        error = `Table not accessible in UI: ${tableName}`;
      }
    } else {
      error = `Table name not provided via the 'table' url param`;
    }

    return { table, error };
  }

  function Form() {
    const { table, error } = getTable();
    if (!table) {
      return <div>{error}</div>;
    }

    if (loadError) {
      return <div>{loadError}</div>;
    }

    if (!recordLoaded) {
      return null;
    }

    if (recordId && !record) {
      return <div>{`No ${table.name} record found: ${recordId}`}</div>;
    }

    return <RecordForm table={table} record={record} />;
  }

  return <Form />;
};
