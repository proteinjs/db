import React from 'react';
import S from 'string';
import moment from 'moment';
import { StringUtil, isInstanceOf } from '@proteinjs/util';
import {
  Form,
  Fields,
  FieldComponentProps,
  FormFieldSection,
  textField,
  checkboxField,
  dateField,
  FormButtons,
} from '@proteinjs/ui';
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
  StringColumn,
  ObjectColumn,
  ArrayColumn,
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
  // The customization contract stays FLAT rows (string[] | string[][]) — customizations
  // narrow/reorder without knowing about sections; the final layout is sectioned afterwards.
  const customizedFieldLayout = recordFormCustomization
    ? recordFormCustomization.getFieldLayout(record, defaultFieldLayout)
    : defaultFieldLayout;

  return (
    <Form
      name={S(table.name).humanize().s}
      createFields={createFields()}
      fieldLayout={sectionizeFieldLayout(customizedFieldLayout)}
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
      if (
        columnPropertyName == 'name' ||
        columnPropertyName == 'id' ||
        columnPropertyName == 'created' ||
        columnPropertyName == 'updated'
      ) {
        continue;
      }

      // A customization's field component surfaces a column the default form hides
      if (column.options?.ui?.hidden && !getFieldRenderer(columnPropertyName)) {
        continue;
      }

      columns[columnPropertyName] = column;
    }

    if (!isNewRecord) {
      // The System section: id (schema-hidden as a DATA column, but the record's address is
      // exactly what an admin copies off a record form — it renders as a readonly mono row),
      // then the stored timestamps.
      if ((table.columns as any)['id']) {
        columns['id'] = getColumn('id');
      }
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

  /**
   * A long-text column (maxLength past the 255 default) gets a multiline input — a
   * single-line input truncates exactly the values (descriptions, failure messages,
   * serialized payloads) an admin opens the form to read.
   */
  function isLongTextColumn(column: Column<T, any>) {
    if (!isInstanceOf(column, StringColumn)) {
      return false;
    }

    const { maxLength } = column as unknown as StringColumn;
    return maxLength === 'MAX' || maxLength > 255;
  }

  /** Pick the field control that tells the truth about the column's type. */
  function createField(columnPropertyName: string, column: Column<T, any>) {
    const name = columnPropertyName;
    const label = StringUtil.humanizeCamel(columnPropertyName);

    const fieldRenderer = getFieldRenderer(columnPropertyName);
    if (fieldRenderer) {
      return customField(name, label, column, fieldRenderer);
    }

    // Readonly values render as text ROWS (no input chrome — @proteinjs/ui's ReadonlyValueRow):
    // copyable ids/timestamps beat a type-specific control the user can't interact with anyway.
    if (isReadonlyField(columnPropertyName, column)) {
      return textField({ name, label, accessibility: { readonly: true }, monospace: columnPropertyName === 'id' });
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

    // Reference columns keep their id controls — they must sit BEFORE the structured/long-text
    // branches (ReferenceArrayColumn descends from ObjectColumn, whose storage is a MAX string).
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

    // Structured values edit as pretty-printed JSON in a mono multiline (loaded/saved through
    // onLoad/getFieldValue).
    if (isInstanceOf(column, ObjectColumn) || isInstanceOf(column, ArrayColumn)) {
      return textField({ name, label, description: 'JSON', multiline: true, monospace: true });
    }

    if (isLongTextColumn(column)) {
      return textField({ name, label, multiline: true });
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

  /**
   * Which form section a column belongs to (the founder's grouping order: identity → content
   * → details/config → system meta last). `column.options.ui.formGroup` overrides the
   * derivation; unknown hint strings become their own titled sections after Details.
   */
  function sectionForColumn(columnPropertyName: string, column: Column<T, any> | undefined): string {
    if (['id', 'created', 'updated'].includes(columnPropertyName)) {
      return 'system';
    }

    const hint = column?.options?.ui?.formGroup;
    if (hint) {
      return hint;
    }

    // Custom-rendered fields (service-owned state like user.roles) are config their component
    // presents — Details unless the column hints otherwise, never Content by storage shape.
    if (getFieldRenderer(columnPropertyName)) {
      return 'details';
    }

    if (columnPropertyName === 'name' || isIdentityColumnName(columnPropertyName)) {
      return 'identity';
    }

    if (
      column &&
      (isLongTextColumn(column) ||
        ((isInstanceOf(column, ObjectColumn) || isInstanceOf(column, ArrayColumn)) &&
          !isInstanceOf(column, ReferenceArrayColumn)))
    ) {
      return 'content';
    }

    return 'details';
  }

  /** Identity-named strings promote to the top (same suffix grammar as the table's column pick). */
  function isIdentityColumnName(columnPropertyName: string) {
    const name = columnPropertyName.toLowerCase();
    return name.endsWith('email') || name.endsWith('title') || ['label', 'subject'].includes(name);
  }

  /** The default flat layout, ordered by section; the customization contract stays flat rows. */
  function fieldLayout(): any {
    const columns = getColumns();
    const layoutColumns = Object.entries(columns).length > 6 ? 2 : 1;

    // Stable order: identity → content → details → custom-hint sections → system.
    const sectionRank = (section: string) => ({ identity: 0, content: 1, details: 2, system: 4 })[section] ?? 3;
    const ordered = Object.keys(columns).sort((a, b) => {
      const rankDelta = sectionRank(sectionForColumn(a, columns[a])) - sectionRank(sectionForColumn(b, columns[b]));
      if (rankDelta !== 0) {
        return rankDelta;
      }
      // Within a section, keep getColumns() order (name first, then schema order).
      return Object.keys(columns).indexOf(a) - Object.keys(columns).indexOf(b);
    });

    if (layoutColumns > 1) {
      const layout: (keyof T)[][] = [];
      let lastRowIsSolo = false;
      let lastSection: string | undefined;
      for (const columnPropertyName of ordered) {
        const column = columns[columnPropertyName];
        const section = sectionForColumn(columnPropertyName, column);
        // Rows never straddle sections — a section boundary always starts a fresh row.
        const sectionChanged = section !== lastSection;
        lastSection = section;
        // Multiline fields (long text / JSON) take a full-width row of their own — half a
        // two-column row squeezes exactly the fields that hold the most text.
        const isMultiline =
          !isReadonlyField(columnPropertyName, column) &&
          !getFieldRenderer(columnPropertyName) &&
          (isLongTextColumn(column) ||
            ((isInstanceOf(column, ObjectColumn) || isInstanceOf(column, ArrayColumn)) &&
              !isInstanceOf(column, ReferenceArrayColumn)));
        // The record's address wants its own line — a uuid halved into a two-column row wraps.
        const isSoloValue = isMultiline || columnPropertyName === 'id';
        if (isSoloValue) {
          layout.push([columnPropertyName as keyof T]);
          lastRowIsSolo = true;
          continue;
        }

        if (
          layout.length == 0 ||
          lastRowIsSolo ||
          sectionChanged ||
          layout[layout.length - 1].length >= layoutColumns
        ) {
          layout.push([]);
          lastRowIsSolo = false;
        }

        layout[layout.length - 1].push(columnPropertyName as keyof T);
      }

      return layout;
    }

    return ordered as (keyof T)[];
  }

  /**
   * Wrap a FLAT layout (default or customization-returned) into the quiet form sections the
   * base Form renders. Each row maps to its first field's section; contiguous runs merge, so a
   * customization's reordering stays honest (an interleaved order yields repeated sections
   * rather than silently re-sorting the fields it chose). A single-section result stays
   * unlabeled — one group needs no header.
   */
  function sectionizeFieldLayout(layout: string[] | string[][]): FormFieldSection<Fields>[] {
    const sectionLabels: { [section: string]: string | undefined } = {
      identity: undefined,
      content: 'Content',
      details: 'Details',
      system: 'System',
    };
    const rows = (layout as (string | string[])[]).map((entry) => (Array.isArray(entry) ? entry : [entry]));
    const sections: { section: string; fields: string[][] }[] = [];
    for (const row of rows) {
      if (row.length === 0) {
        continue;
      }

      const section = sectionForColumn(row[0], getColumn(row[0]));
      const last = sections[sections.length - 1];
      if (last && last.section === section) {
        last.fields.push(row);
      } else {
        sections.push({ section, fields: [row] });
      }
    }

    if (sections.length <= 1) {
      return sections.map(({ fields }) => ({ fields }) as FormFieldSection<Fields>);
    }

    return sections.map(({ section, fields }) => ({
      label: section in sectionLabels ? sectionLabels[section] : StringUtil.humanizeCamel(section),
      fields,
    })) as FormFieldSection<Fields>[];
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

    // Structured columns round-trip through the JSON the multiline field presents; a paste
    // that isn't JSON fails the save with a message naming the field, not a driver error.
    if (
      (isInstanceOf(column, ObjectColumn) || isInstanceOf(column, ArrayColumn)) &&
      !isInstanceOf(column, ReferenceArrayColumn)
    ) {
      if (typeof fieldValue !== 'string' || !fieldValue.trim()) {
        return null;
      }

      try {
        return JSON.parse(fieldValue);
      } catch {
        throw new Error(`${StringUtil.humanizeCamel(columnPropertyName)} must be valid JSON`);
      }
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
        // Readonly timestamps (created/updated/DateTimeColumn) display compact and copyable,
        // with the relative read ('2 hours ago') as the field's helper line.
        field.description = fieldValue.fromNow();
        fieldValue = fieldValue.format('MMM D, YYYY, h:mm A');
      } else if (
        (isInstanceOf(column, ObjectColumn) || isInstanceOf(column, ArrayColumn)) &&
        !isInstanceOf(column, ReferenceArrayColumn) &&
        fieldValue != null &&
        typeof fieldValue !== 'string'
      ) {
        // Structured values present as pretty-printed JSON in their multiline field
        fieldValue = JSON.stringify(fieldValue, null, 2);
      }

      field.value = fieldValue;
    }
  }
}
