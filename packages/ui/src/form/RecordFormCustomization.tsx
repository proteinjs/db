import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { FormButtons } from '@proteinjs/ui';
import { Table } from '@proteinjs/db';

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
}
