/* eslint-disable no-ex-assign */
import React from 'react';
import { FormPage, Page, PageComponentProps } from '@proteinjs/ui';
import { getDbService, tableByName } from '@proteinjs/db';
import { RecordForm } from '../form/RecordForm';

export const recordFormPage: Page = {
  name: 'Record Form',
  path: 'record/form',
  auth: {
    allUsers: true,
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
  const [record, setRecord] = React.useState();

  React.useEffect(() => {
    const fetchData = async () => {
      const { table } = getTable();
      if (!table) {
        return;
      }

      const recordId = urlParams['record'];
      if (!recordId) {
        return;
      }

      const fetchedRecord = await getDbService().get(table, { id: recordId });
      setRecord(fetchedRecord);
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

    return <RecordForm table={table} record={record} />;
  }

  return <Form />;
};
