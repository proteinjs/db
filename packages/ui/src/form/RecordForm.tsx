import React from 'react';
import S from 'string';
import moment from 'moment';
import { StringUtil, isInstanceOf } from '@proteinjs/util';
import { Form, Fields, textField, FormButtons } from '@proteinjs/ui';
import { Table, Record, Column, getDbService, DateTimeColumn, BooleanColumn } from '@proteinjs/db';
import { recordTableLink } from '../pages/RecordTablePage';
import { recordFormLink } from '../pages/RecordFormPage';
import { getRecordFormCustomization } from './RecordFormCustomization';

export type RecordFormProps<T extends Record> = {
  table: Table<T>;
  record?: T;
};

export function RecordForm<T extends Record>({ table, record }: RecordFormProps<T>) {
  const isNewRecord = typeof record === 'undefined';
  const recordFormCustomization = getRecordFormCustomization(table.name);
  return (
    <Form
      name={S(table.name).humanize().s}
      createFields={createFields()}
      fieldLayout={fieldLayout()}
      buttons={
        recordFormCustomization?.getFormButtons ? recordFormCustomization.getFormButtons(record, buttons()) : buttons()
      }
      onLoad={onLoad}
      onLoadProgressMessage={`Loading ${S(table.name).humanize().s}`}
    />
  );

  function getColumns() {
    const columns: { [columnPropertyName: string]: Column<T, any> } = {};
    const nameColumn = (table.columns as any)['name'] as Column<T, any>;
    if (nameColumn) {
      columns['name'] = nameColumn;
    }

    for (const columnPropertyName in table.columns) {
      const column = (table.columns as any)[columnPropertyName] as Column<T, any>;
      if (columnPropertyName == 'name' || columnPropertyName == 'created' || columnPropertyName == 'updated') {
        continue;
      }

      if (column.options?.ui?.hidden) {
        continue;
      }

      columns[columnPropertyName] = column;
    }

    if (!isNewRecord) {
      columns['created'] = (table.columns as any)['created'] as Column<T, any>;
      columns['updated'] = (table.columns as any)['updated'] as Column<T, any>;
    }

    return columns;
  }

  function createFields(): () => Fields {
    return () => {
      const fields: Fields = {};
      for (const columnPropertyName in getColumns()) {
        fields[columnPropertyName] = textField({
          name: columnPropertyName,
          label: StringUtil.humanizeCamel(columnPropertyName),
        });
      }

      return fields;
    };
  }

  function fieldLayout(): any {
    const columns = getColumns();
    const layoutColumns = Object.entries(columns).length > 6 ? 2 : 1;
    if (layoutColumns > 1) {
      const layout: (keyof T)[][] = [];
      for (const columnPropertyName in columns) {
        if (layout.length == 0 || layout[layout.length - 1].length >= layoutColumns) {
          layout.push([]);
        }

        layout[layout.length - 1].push(columnPropertyName as keyof T);
      }

      return layout;
    }

    return Object.keys(columns) as (keyof T)[];
  }

  function buttons(): FormButtons<any> {
    let newRecord: T;
    return {
      delete: {
        name: 'Delete',
        accessibility: {
          hidden: isNewRecord,
        },
        style: {
          color: 'primary',
          variant: 'text',
        },
        redirect: async (fields: Fields, buttons: FormButtons<Fields>) => {
          return { path: recordTableLink(table) };
        },
        onClick: async (fields: Fields, buttons: FormButtons<Fields>) => {
          if (!record || !record.id) {
            throw new Error(`Unable to delete record, record or id undefined`);
          }

          await getDbService().delete(table, { id: record.id } as any);
          return `Deleted ${S(table.name).humanize().s}`;
        },
        progressMessage: (fields: Fields) => {
          return `Deleting ${S(table.name).humanize().s}`;
        },
      },
      save: {
        name: 'Save',
        accessibility: {
          hidden: isNewRecord,
        },
        style: {
          color: 'primary',
          variant: 'contained',
        },
        onClick: async (fields: Fields, buttons: FormButtons<Fields>) => {
          if (!record || !record.id) {
            throw new Error(`Unable to save record, record or id undefined`);
          }

          for (const columnPropertyName in fields) {
            const field = fields[columnPropertyName];
            (record as any)[columnPropertyName] = field.field.value;
          }

          await getDbService().update(table, record);
          return `Saved ${S(table.name).humanize().s}`;
        },
        progressMessage: (fields: Fields) => {
          return `Saving ${S(table.name).humanize().s}`;
        },
      },
      create: {
        name: 'Create',
        accessibility: {
          hidden: !isNewRecord,
        },
        style: {
          color: 'primary',
          variant: 'contained',
        },
        redirect: async (fields: Fields, buttons: FormButtons<Fields>) => {
          return { path: recordFormLink(table.name, newRecord.id) };
        },
        onClick: async (fields: Fields, buttons: FormButtons<Fields>) => {
          const record: any = {};
          for (const columnPropertyName in fields) {
            const field = fields[columnPropertyName];
            (record as any)[columnPropertyName] = field.field.value;
          }

          newRecord = await getDbService().insert(table, record);
          return `Created ${S(table.name).humanize().s}`;
        },
        progressMessage: (fields: Fields) => {
          return `Creating ${S(table.name).humanize().s}`;
        },
      },
    };
  }

  async function onLoad(fields: Fields, buttons: FormButtons<Fields>) {
    if (isNewRecord) {
      return;
    }

    for (const columnPropertyName in fields) {
      const column = (table.columns as any)[columnPropertyName] as Column<any, any>;
      const field = fields[columnPropertyName].field;
      let fieldValue = (record as any)[columnPropertyName];
      if (moment.isMoment(fieldValue)) {
        fieldValue = fieldValue.format('ddd, MMM Do YY, h:mm:ss a');
      } else if (isInstanceOf(column, BooleanColumn)) {
        fieldValue = fieldValue == true ? 'True' : 'False';
      }

      field.value = fieldValue;
      if (
        columnPropertyName == 'created' ||
        columnPropertyName == 'updated' ||
        columnPropertyName == 'id' ||
        isInstanceOf(column, DateTimeColumn)
      ) {
        if (!field.accessibility) {
          field.accessibility = {};
        }

        field.accessibility.readonly = true;
      }
    }
  }
}
