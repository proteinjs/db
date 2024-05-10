import { Table, StringColumn, Record, withRecordColumns, ObjectColumn } from '@proteinjs/db';

export interface Setting extends Record {
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
  public columns = withRecordColumns<Setting>({
    name: new StringColumn('name'),
    value: new ObjectColumn('value'),
  });
}
