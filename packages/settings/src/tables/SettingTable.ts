import { Table, StringColumn, ObjectColumn } from '@proteinjs/db';
import { ScopedRecord, createScopedIndex, withScopedRecordColumns } from '@proteinjs/user';

export interface Setting extends ScopedRecord {
  name: string;
  value: any;
}

/**
 * One row per name within a scope, by declaration: the unique index over (scope, name) is what
 * keeps two writers from creating two rows of one name — `Settings.set` inserts, the index refuses
 * the second writer's insert, and that writer updates the one row. The same name in another scope
 * is another person's setting, its own row. A database that predates the index reaches the
 * invariant through `DeduplicateSettingRows`, which runs before the index is added.
 */
export class SettingTable extends Table<Setting> {
  public name = 'setting';
  public indexes: Table<Setting>['indexes'] = [
    createScopedIndex<Setting>({ columns: ['name'], name: 'setting_scope_name_unique', unique: true }),
  ];
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
