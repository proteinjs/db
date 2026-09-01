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
    /**
     * The chunked file BYTES (base64) — encryptable, but deliberately NOT encrypted by
     * default (founder ruling 2026-08-31): n3xa stores file bytes in GCS, not here, and a
     * framework-level default would force the cost on every consumer. If a consumer wants
     * its in-database file bytes encrypted, that becomes an OPT-IN flag at the consumer's
     * deployment (a named wave-B framework feature), never a default.
     */
    data: new StringColumn('data', { encrypted: false }, 'MAX'),
  });
}
