import { Table, StringColumn, IntegerColumn, ReferenceColumn, Reference } from '@proteinjs/db';
import { ScopedRecord, withScopedRecordColumns } from '@proteinjs/user';
import { File, FileTable } from './FileTable';

export interface FileData extends ScopedRecord {
  file: Reference<File>;
  order: number;
  data: string;
}

export class FileDataTable extends Table<FileData> {
  public name = 'file_data';
  public auth: Table<FileData>['auth'] = {
    db: {
      all: 'authenticated',
    },
    service: {
      all: 'authenticated',
    },
  };
  public columns = withScopedRecordColumns<FileData>({
    file: new ReferenceColumn<File>('file', new FileTable().name, false),
    order: new IntegerColumn('order'),
    data: new StringColumn('data', {}, 'MAX'),
  });
}