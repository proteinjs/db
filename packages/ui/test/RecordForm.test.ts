import { Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import { stripServiceProtectedColumns } from '../src/form/RecordForm';

/**
 * The record form's save path sends the whole loaded record; service-protected columns must be
 * stripped from that payload — TableServiceAuth rejects any service write that sets one, so a
 * form that echoed the loaded value back would make every save of such a record fail.
 */

interface Doc extends Record {
  title: string;
  owner?: string | null;
}

class ProtectedColumnTable extends Table<Doc> {
  public name = 'record_form_protected_test';
  public auth: Table<Doc>['auth'] = {
    service: { all: 'authenticated' },
    serviceProtectedColumns: ['owner'],
  };
  public columns = withRecordColumns<Doc>({
    title: new StringColumn('title'),
    owner: new StringColumn('owner'),
  });
}

class OpenTable extends Table<Doc> {
  public name = 'record_form_open_test';
  public columns = withRecordColumns<Doc>({
    title: new StringColumn('title'),
    owner: new StringColumn('owner'),
  });
}

const record = { id: 'doc-1', title: 't', owner: 'server-set-owner' } as Doc;

describe('stripServiceProtectedColumns', () => {
  it('drops protected columns from the save payload and keeps everything else', () => {
    const payload = stripServiceProtectedColumns(new ProtectedColumnTable(), record);
    expect(payload).toEqual({ id: 'doc-1', title: 't' });
  });

  it('leaves records untouched on tables without protected columns', () => {
    const payload = stripServiceProtectedColumns(new OpenTable(), record);
    expect(payload).toEqual(record);
  });

  it('does not mutate the loaded record (the form re-renders from it)', () => {
    stripServiceProtectedColumns(new ProtectedColumnTable(), record);
    expect(record.owner).toBe('server-set-owner');
  });
});
