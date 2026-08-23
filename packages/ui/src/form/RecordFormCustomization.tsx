import React from 'react';
import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { FormButtons } from '@proteinjs/ui';
import { Column, Record, Table } from '@proteinjs/db';

export const getRecordFormCustomizations = () =>
  SourceRepository.get().objects<RecordFormCustomization>('@proteinjs/db-ui/RecordFormCustomization');

export const getRecordFormCustomization = (tableName: string) => {
  const recordFormCustomizations = getRecordFormCustomizations();
  for (const recordFormCustomization of recordFormCustomizations) {
    if (recordFormCustomization.table.name == tableName) {
      return recordFormCustomization;
    }
  }
};

/**
 * What a custom field component receives. The component OWNS its field: it presents `value`
 * (read from the loaded record) and performs any edit through a service of its own, then calls
 * `reload` so the slot shows the stored truth. The form's save payload never carries a
 * custom-rendered field.
 */
export type RecordFormFieldProps<T extends Record = any, V = any> = {
  table: Table<T>;
  column: Column<T, any>;
  /** The column's property name on the record (the field's key in the form layout). */
  fieldName: string;
  /** The humanized label the default control would have carried. */
  label: string;
  /** The loaded record. Renderers are only consulted for existing records, so this is never undefined. */
  record: T;
  value: V;
  /** Re-read the record through the db service and re-render the form from it. */
  reload: () => Promise<void>;
};

export type RecordFormFieldRenderer<T extends Record = any> = React.ComponentType<RecordFormFieldProps<T>>;

export abstract class RecordFormCustomization implements Loadable {
  abstract table: Table<any>;

  getFormButtons(record: any, defaultFormButtons: FormButtons<any>): FormButtons<any> {
    return defaultFormButtons;
  }

  /**
   * Narrow or reorder the fields the form renders. `record` is undefined when the form is creating a
   * new record, so a customization that replaces the create action with a domain action (ie. sending
   * an invite) can show only the fields that action actually consumes.
   */
  getFieldLayout(record: any, defaultFieldLayout: string[] | string[][]): string[] | string[][] {
    return defaultFieldLayout;
  }

  /**
   * Take over a field's slot with a component of your own (see `RecordFormFieldProps` for what it
   * receives and owns). Declaring a renderer also surfaces a column the default form hides (ie. an
   * `ArrayColumn`), so service-owned state like `user.roles` can be presented and acted on from the
   * record form without the form's generic controls pretending to edit it.
   *
   * Consulted only for existing records: a record that doesn't exist yet has no stored state to
   * present or service to write through, so the new-record form renders its default controls.
   */
  getFieldRenderer(fieldName: string, record: any): RecordFormFieldRenderer | undefined {
    return undefined;
  }
}
