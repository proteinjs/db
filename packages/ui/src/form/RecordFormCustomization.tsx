import { Loadable, SourceRepository } from '@proteinjs/reflection'
import { FormButtons } from '@proteinjs/ui'
import { Table } from '@proteinjs/db'

export const getRecordFormCustomizations = () => SourceRepository.get().objects<RecordFormCustomization>('@proteinjs/db-ui/RecordFormCustomization');

export const getRecordFormCustomization = (tableName: string) => {
  const recordFormCustomizations = getRecordFormCustomizations();
  for (let recordFormCustomization of recordFormCustomizations) {
    if (recordFormCustomization.table.name == tableName)
      return recordFormCustomization;
  }
}

export abstract class RecordFormCustomization implements Loadable {
  abstract table: Table<any>;
	getFormButtons(record: any, defaultFormButtons: FormButtons<any>): FormButtons<any> {
    return defaultFormButtons;
  }
}