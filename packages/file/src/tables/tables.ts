import { Table } from '@proteinjs/db';
import { FileTable, File } from './FileTable';
import { FileDataTable, FileData } from './FileDataTable';

export const tables = {
  File: new FileTable() as Table<File>,
  FileData: new FileDataTable() as Table<FileData>,
};
