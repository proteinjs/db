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
    name: new StringColumn('name', { encrypted: false }), // machine setting keys
    value: new ObjectColumn('value', { encrypted: false }), // encryption wave-B residue: per-user view/config state — metadata by ruling today; revisit if settings ever carry words
  });
}
