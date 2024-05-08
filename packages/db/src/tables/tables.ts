import { Table } from '../Table';
import { Migration, MigrationTable } from './MigrationTable';

export const tables = {
  Migration: new MigrationTable() as Table<Migration>,
};
