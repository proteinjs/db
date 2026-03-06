import React from 'react';
import S from 'string';
import moment from 'moment';
import { StringUtil, isInstanceOf } from '@proteinjs/util';
import { Form, Fields, textField, FormButtons } from '@proteinjs/ui';
import {
  Table,
  Record,
  Column,
  getDbService,
  DateTimeColumn,
  BooleanColumn,
  Reference,
  ReferenceArray,
  ReferenceColumn,
  ReferenceArrayColumn,
} from '@proteinjs/db';
import { recordTableLink } from '../pages/RecordTablePage';
import { recordFormLink } from '../pages/RecordFormPage';
import { getRecordFormCustomization } from './RecordFormCustomization';

export type RecordFormProps<T extends Record> = {
  table: Table<T>;
  record?: T;
};

type PlainObject = { [key: string]: unknown };

function isObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null;
}

function isReferenceValue(value: unknown): value is { _table: string; _id: string | null } {
  return (
    isObject(value) &&
    typeof value['_table'] === 'string' &&
    (typeof value['_id'] === 'string' || value['_id'] === null)
  );
}

function isReferenceArrayValue(value: unknown): value is { _table: string; _ids: string[] } {
  return isObject(value) && typeof value['_table'] === 'string' && Array.isArray(value['_ids']);
}

function parseReferenceId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const id = value.trim();
  return id ? id : null;
}

function parseReferenceIds(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }

  return value
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function parseBooleanValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  return null;
}

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

  function getColumn(columnPropertyName: string) {
    return (table.columns as any)[columnPropertyName] as Column<T, any>;
  }

  function getColumns() {
    const columns: { [columnPropertyName: string]: Column<T, any> } = {};
    const nameColumn = (table.columns as any)['name'] as Column<T, any>;
    if (nameColumn) {
      columns['name'] = nameColumn;
    }

    for (const columnPropertyName in table.columns) {
      const column = getColumn(columnPropertyName);
      if (columnPropertyName == 'name' || columnPropertyName == 'created' || columnPropertyName == 'updated') {
        continue;
      }

      if (column.options?.ui?.hidden) {
        continue;
      }

      columns[columnPropertyName] = column;
    }

    if (!isNewRecord) {
      columns['created'] = getColumn('created');
      columns['updated'] = getColumn('updated');
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

  function getFieldValue(columnPropertyName: string, fieldValue: unknown) {
    const column = getColumn(columnPropertyName);
    const currentValue = record ? (record as any)[columnPropertyName] : undefined;

    if (isReferenceValue(currentValue)) {
      const id = parseReferenceId(fieldValue);
      return id ? new Reference(currentValue._table, id) : null;
    }

    if (isReferenceArrayValue(currentValue)) {
      return new ReferenceArray(currentValue._table, parseReferenceIds(fieldValue));
    }

    if (isInstanceOf(column, ReferenceColumn)) {
      const id = parseReferenceId(fieldValue);
      return id ? new Reference(column.referenceTable, id) : null;
    }

    if (isInstanceOf(column, ReferenceArrayColumn)) {
      return new ReferenceArray(column.referenceTable, parseReferenceIds(fieldValue));
    }

    if (isInstanceOf(column, BooleanColumn)) {
      return parseBooleanValue(fieldValue);
    }

    return fieldValue;
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
            (record as any)[columnPropertyName] = getFieldValue(columnPropertyName, field.field.value);
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
            record[columnPropertyName] = getFieldValue(columnPropertyName, field.field.value);
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
      const column = getColumn(columnPropertyName);
      const field = fields[columnPropertyName].field;
      let fieldValue = (record as any)[columnPropertyName];

      if (moment.isMoment(fieldValue)) {
        fieldValue = fieldValue.format('ddd, MMM Do YY, h:mm:ss a');
      } else if (isReferenceValue(fieldValue)) {
        fieldValue = fieldValue._id || '';
      } else if (isReferenceArrayValue(fieldValue)) {
        fieldValue = fieldValue._ids.join(', ');
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
