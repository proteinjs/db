import { Table, StringColumn, IntegerColumn } from '@proteinjs/db';
import { ScopedRecord, withScopedRecordColumns } from '@proteinjs/user';
import { FileDataTable } from './FileDataTable';

export interface File extends ScopedRecord {
  name: string;
  type: string;
  size: number;
}

export class FileTable extends Table<File> {
  public name = 'file';
  public auth: Table<File>['auth'] = {
    db: {
      all: 'authenticated',
    },
    service: {
      all: 'authenticated',
    },
  };
  public columns = withScopedRecordColumns<File>({
    name: new StringColumn('name'),
    type: new StringColumn('type'),
    size: new IntegerColumn('size'),
  });
  public cascadeDeleteReferences = () => [
    {
      table: new FileDataTable().name,
      referenceColumn: new FileDataTable().columns.file.name,
    },
  ];
}