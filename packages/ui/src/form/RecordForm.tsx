import React from 'react';
import S from 'string';
import moment from 'moment';
import { StringUtil, isInstanceOf } from '@proteinjs/util';
import { Form, Fields, FieldComponentProps, textField, checkboxField, dateField, FormButtons } from '@proteinjs/ui';
import {
  Table,
  Record,
  Column,
  getDbService,
  DateColumn,
  DateTimeColumn,
  BooleanColumn,
  Reference,
  ReferenceArray,
  ReferenceColumn,
  ReferenceArrayColumn,
} from '@proteinjs/db';
import { recordTableLink } from '../pages/RecordTablePage';
import { recordFormLink } from '../pages/RecordFormPage';
import { getRecordFormCustomization, RecordFormFieldRenderer } from './RecordFormCustomization';

export type RecordFormProps<T extends Record> = {
  table: Table<T>;
  record?: T;
};

/**
 * Service-protected columns are reserved to server write paths (e.g. user.roles → the Roles
 * service). The form never renders them, but a loaded record still carries their values —
 * sending them back would be rejected by TableServiceAuth as a protected-column write. The form
 * physically cannot set them; its save payload must not carry them.
 */
export function stripServiceProtectedColumns<T extends Record>(table: Table<T>, record: T): Partial<T> {
  const payload: any = { ...record };
  for (const protectedColumn of table.auth?.serviceProtectedColumns ?? []) {
    delete payload[protectedColumn];
  }

  return payload;
}

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

/** Parse a native date/datetime-local input value ('YYYY-MM-DD' / 'YYYY-MM-DDTHH:mm'). */
function parseDateInputValue(value: unknown): moment.Moment | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  return moment(value);
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
  const defaultFieldLayout = fieldLayout();
  const defaultFormButtons = buttons();

  return (
    <Form
      name={S(table.name).humanize().s}
      createFields={createFields()}
      fieldLayout={
        recordFormCustomization
          ? recordFormCustomization.getFieldLayout(record, defaultFieldLayout)
          : defaultFieldLayout
      }
      buttons={
        recordFormCustomization
          ? recordFormCustomization.getFormButtons(record, defaultFormButtons)
          : defaultFormButtons
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

      // A customization's field component surfaces a column the default form hides
      if (column.options?.ui?.hidden && !getFieldRenderer(columnPropertyName)) {
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
      const columns = getColumns();
      for (const columnPropertyName in columns) {
        fields[columnPropertyName] = createField(columnPropertyName, columns[columnPropertyName]);
      }

      return fields;
    };
  }

  /**
   * Server-managed columns (`id`/`created`/`updated`) and stored timestamps (`DateTimeColumn`)
   * are readonly on existing records; readonly was previously applied in `onLoad`, which made
   * field-control selection impossible at creation time — it lives here now so each column type
   * can pick its control up front.
   */
  function isReadonlyField(columnPropertyName: string, column: Column<T, any>) {
    return (
      !isNewRecord &&
      (columnPropertyName == 'id' ||
        columnPropertyName == 'created' ||
        columnPropertyName == 'updated' ||
        isInstanceOf(column, DateTimeColumn))
    );
  }

  /**
   * A customization's component for the field, if it declared one. Only existing records have
   * stored state to present, so the new-record form never consults renderers (see
   * `RecordFormCustomization.getFieldRenderer`).
   */
  function getFieldRenderer(columnPropertyName: string): RecordFormFieldRenderer<T> | undefined {
    if (isNewRecord || !recordFormCustomization) {
      return undefined;
    }

    return recordFormCustomization.getFieldRenderer(columnPropertyName, record);
  }

  /** Pick the field control that tells the truth about the column's type. */
  function createField(columnPropertyName: string, column: Column<T, any>) {
    const name = columnPropertyName;
    const label = StringUtil.humanizeCamel(columnPropertyName);

    const fieldRenderer = getFieldRenderer(columnPropertyName);
    if (fieldRenderer) {
      return customField(name, label, column, fieldRenderer);
    }

    // Readonly values render as text (a native date input isn't text-selectable): copyable
    // ids/timestamps beat a type-specific control the user can't interact with anyway.
    if (isReadonlyField(columnPropertyName, column)) {
      return textField({ name, label, accessibility: { readonly: true } });
    }

    if (isInstanceOf(column, BooleanColumn)) {
      return checkboxField({ name, label });
    }

    if (isInstanceOf(column, DateColumn)) {
      return dateField({ name, label });
    }

    // Only reachable on new-record forms; on existing records DateTimeColumns are readonly.
    if (isInstanceOf(column, DateTimeColumn)) {
      return dateField({ name, label, includeTime: true });
    }

    if (isInstanceOf(column, ReferenceColumn)) {
      const { referenceTable } = column as unknown as ReferenceColumn<any>;
      return textField({
        name,
        label,
        description: `${referenceTable} record id`,
        onChange: async (value, fields, setFieldStatus) => {
          if (typeof value === 'string' && value.includes(',')) {
            setFieldStatus(`Enter a single ${referenceTable} record id`, true);
          }
        },
      });
    }

    if (isInstanceOf(column, ReferenceArrayColumn)) {
      const { referenceTable } = column as unknown as ReferenceArrayColumn<any>;
      return textField({
        name,
        label,
        description: `Comma-separated ${referenceTable} record ids`,
      });
    }

    return textField({ name, label });
  }

  /**
   * The slot a customization's component renders in. The component reads its value from the
   * loaded record (not the form's field value), so one `reload` refreshes every custom field:
   * reload re-reads the record in place and reports the change through the form's own onChange,
   * which is what re-renders the form.
   */
  function customField(name: string, label: string, column: Column<T, any>, FieldRenderer: RecordFormFieldRenderer<T>) {
    const loadedRecord = record as T;
    return {
      field: { name, label },
      component: ({ field, onChange }: FieldComponentProps<any, Fields>) => (
        <FieldRenderer
          table={table}
          column={column}
          fieldName={name}
          label={label}
          record={loadedRecord}
          value={(loadedRecord as any)[name]}
          reload={async () => {
            const fresh = await getDbService().get(table, { id: loadedRecord.id } as any);
            if (!fresh) {
              throw new Error(`${S(table.name).humanize().s} no longer exists`);
            }

            Object.assign(loadedRecord, fresh);
            await onChange(field, (fresh as any)[name], () => {});
          }}
        />
      ),
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

    if (isInstanceOf(column, DateColumn)) {
      return parseDateInputValue(fieldValue)?.toDate() ?? null;
    }

    if (isInstanceOf(column, DateTimeColumn)) {
      return parseDateInputValue(fieldValue);
    }

    return fieldValue;
  }

  /**
   * The update payload is the loaded record minus what this form doesn't own: service-protected
   * columns, and custom-rendered fields — those are their component's, written through the
   * component's own service. Echoing a loaded value back would clobber whatever that service
   * wrote since the load.
   */
  function savePayload(): Partial<T> {
    const payload: any = stripServiceProtectedColumns(table, record as T);
    for (const columnPropertyName in getColumns()) {
      if (getFieldRenderer(columnPropertyName)) {
        delete payload[columnPropertyName];
      }
    }

    return payload;
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
        confirm: (fields: Fields) => ({
          title: `Delete ${S(table.name).humanize().s}?`,
          message: 'This permanently deletes the record.',
          confirmButtonText: 'Delete',
        }),
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
            // Readonly fields are display-only; their values are formatted strings. The loaded
            // record already holds the real values (id keys the update; created/updated stay
            // moments — writing the display string back serialized `created` to null on save).
            if (isReadonlyField(columnPropertyName, getColumn(columnPropertyName))) {
              continue;
            }

            if (getFieldRenderer(columnPropertyName)) {
              continue;
            }

            const field = fields[columnPropertyName];
            (record as any)[columnPropertyName] = getFieldValue(columnPropertyName, field.field.value);
          }

          await getDbService().update(table, savePayload());
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
      // Custom-rendered fields read straight from the loaded record
      if (getFieldRenderer(columnPropertyName)) {
        continue;
      }

      const column = getColumn(columnPropertyName);
      const field = fields[columnPropertyName].field;
      let fieldValue = (record as any)[columnPropertyName];

      if (isReferenceValue(fieldValue)) {
        fieldValue = fieldValue._id || '';
      } else if (isReferenceArrayValue(fieldValue)) {
        fieldValue = fieldValue._ids.join(', ');
      } else if (isInstanceOf(column, BooleanColumn)) {
        // The checkbox control takes a real boolean, not a 'True'/'False' display string
        fieldValue = fieldValue == true;
      } else if (isInstanceOf(column, DateColumn) && fieldValue) {
        // The native date input takes its own value format
        fieldValue = moment(fieldValue).format('YYYY-MM-DD');
      } else if (moment.isMoment(fieldValue)) {
        // Readonly timestamps (created/updated/DateTimeColumn) display human-formatted, copyable
        fieldValue = fieldValue.format('ddd, MMM Do YY, h:mm:ss a');
      }

      field.value = fieldValue;
    }
  }
}
