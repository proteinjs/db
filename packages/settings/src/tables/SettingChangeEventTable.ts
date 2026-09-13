import { ObjectColumn, Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import { USER_PERMISSIONS } from '@proteinjs/user';

/**
 * Audit row written by the settings admin door (`SettingsAdmin.writeSetting`) for EVERY write it
 * makes to another account's settings. The base `created` column is the change timestamp; `before`
 * is the record as it was stored (null when the account had no row for `name`), `after` the record
 * as written. Rows are append-only: readable by 'users' holders (the same trust that manages user
 * records), written only by the admin door's system path — no generic door grants writes, so the
 * trail cannot be edited from the record surfaces.
 */
export type SettingChangeEvent = Record & {
  /** id of the user who made the change */
  actor: string;
  /** id of the user whose setting changed */
  target: string;
  /** the setting's name (the `setting` row's `name`) */
  name: string;
  before: any;
  after: any;
};

export class SettingChangeEventTable extends Table<SettingChangeEvent> {
  name = 'setting_change_event';
  auth: Table<SettingChangeEvent>['auth'] = {
    db: {
      query: { permission: USER_PERMISSIONS.users },
    },
    service: {
      query: { permission: USER_PERMISSIONS.users },
    },
  };
  columns: Table<SettingChangeEvent>['columns'] = withRecordColumns<SettingChangeEvent>({
    actor: new StringColumn('actor', {}, 36),
    target: new StringColumn('target', {}, 36),
    name: new StringColumn('name'),
    before: new ObjectColumn('before'),
    after: new ObjectColumn('after'),
  });
}
