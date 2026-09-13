import { Table } from '@proteinjs/db';
import { Setting, SettingTable } from './SettingTable';
import { SettingChangeEvent, SettingChangeEventTable } from './SettingChangeEventTable';

export const tables = {
  Setting: new SettingTable() as Table<Setting>,
  SettingChangeEvent: new SettingChangeEventTable() as Table<SettingChangeEvent>,
};
