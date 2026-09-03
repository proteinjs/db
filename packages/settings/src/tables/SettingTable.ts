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
    // Per-user view/config state — and the words a user types into saved table filters
    // (`TableFilterCondition.value`: "contains: divorce") ride here too. Encrypted whole-value
    // (founder ruling 2026-09-03, ENCRYPTED_THOUGHT_OBJECT §7 #9): the row's scope is its owner, so
    // a user's own settings decrypt for them and no one reading the database sees the filter words.
    // Never queried by value.
    value: new ObjectColumn('value', { encrypted: {} }),
  });
}
