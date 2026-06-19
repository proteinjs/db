import { Table, StringColumn, IntegerColumn, ReferenceColumn, Reference } from '@proteinjs/db';
import { ScopedRecord, withScopedRecordColumns } from '@proteinjs/user';
import { FileDataTable } from './FileDataTable';

const FILE_TABLE_NAME = 'file';

export interface File extends ScopedRecord {
  name: string;
  type: string;
  size: number;
  /**
   * Optional preview — another `File` (stored the same way, in GCS) used as a preview/thumbnail of
   * this file's content, e.g. a recording GIF's preview frame. A reference, not an inline blob, so
   * the bytes stay out of the DB row (consistent with the storage model); deleted with this file.
   */
  preview?: Reference<File>;
}

export class FileTable extends Table<File> {
  public name = FILE_TABLE_NAME;
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
    // Self-reference (the preview is itself a File). cascadeDelete: removing a file removes its preview.
    preview: new ReferenceColumn<File>('preview', FILE_TABLE_NAME, true),
  });
  public cascadeDeleteReferences = () => [
    {
      table: new FileDataTable().name,
      referenceColumn: new FileDataTable().columns.file.name,
    },
  ];
}
