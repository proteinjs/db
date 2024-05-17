import { Table, StringColumn, ObjectColumn } from '@proteinjs/db';
import { ScopedRecord, withScopedRecordColumns } from '@proteinjs/user';

export interface Setting extends ScopedRecord {
  name: string;
  value: any;
}

export class SettingTable extends Table<Setting> {
  public name = 'setting';
  public auth: Table<Setting>['auth'] = {
    db: {
      all: 'authenticated',
    },
    service: {
      all: 'authenticated',
    },
  };
  public columns = withScopedRecordColumns<Setting>({
    name: new StringColumn('name'),
    value: new ObjectColumn('value'),
  });
}
