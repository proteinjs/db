import { Table } from '@proteinjs/db';
import { Setting, SettingTable } from './SettingTable';

export const tables = {
  Setting: new SettingTable() as Table<Setting>,
}