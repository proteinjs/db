import { UserAuth } from '@proteinjs/user-auth';
import { Table } from '../src/Table';
import { withRecordColumns, Record } from '../src/Record';
import { StringColumn } from '../src/Columns';
import { TableServiceAuth } from '../src/auth/TableServiceAuth';

/**
 * Covers the service-path (RPC) table auth gate:
 * - per-operation `service` grants (query stays open while writes are role-gated)
 * - `canDelete` honoring the `delete` grant (not `query` — the pre-fix behavior let any
 *   authenticated user delete from read-only tables)
 * - `auth.serviceProtectedColumns`: columns that can never be SET via the service path,
 *   rejected with a clean `ServiceError` (message passes through to the client verbatim)
 *
 * `UserAuth` reads from a static repo; tests stub it directly per identity — no server needed.
 */

interface Doc extends Record {
  title: string;
  owner?: string | null;
}

/** Mirrors the flow run-graph tables: reads authenticated, writes admin-only. */
class ServerWrittenTable extends Table<Doc> {
  public name = 'server_written_test';
  public auth: Table<Doc>['auth'] = {
    db: { all: 'authenticated' },
    service: { query: 'authenticated', insert: ['admin'], update: ['admin'], delete: ['admin'] },
  };
  public columns = withRecordColumns<Doc>({
    title: new StringColumn('title'),
    owner: new StringColumn('owner'),
  });
}

/** Mirrors the chat table: client-writable, but `owner` is reserved to server code. */
class ProtectedColumnTable extends Table<Doc> {
  public name = 'protected_column_test';
  public auth: Table<Doc>['auth'] = {
    db: { all: 'authenticated' },
    service: { all: 'authenticated' },
    serviceProtectedColumns: ['owner'],
  };
  public columns = withRecordColumns<Doc>({
    title: new StringColumn('title'),
    owner: new StringColumn('owner'),
  });
}

/** Read-only intent: only `query` granted (the canDelete-regression shape). */
class ReadOnlyTable extends Table<Doc> {
  public name = 'read_only_test';
  public auth: Table<Doc>['auth'] = {
    db: { query: 'authenticated' },
    service: { query: 'authenticated' },
  };
  public columns = withRecordColumns<Doc>({
    title: new StringColumn('title'),
    owner: new StringColumn('owner'),
  });
}

type UserAuthInternals = { userRepo?: { getUser: () => { email: string; roles: string[] } } };

const setUser = (roles: string[]) => {
  (UserAuth as unknown as UserAuthInternals).userRepo = {
    getUser: () => ({ email: 'user@test.local', roles }),
  };
};

const auth = () => new TableServiceAuth();

describe('TableServiceAuth — per-operation service grants', () => {
  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  });

  it('authenticated non-admin: reads allowed, writes denied on a server-written table', () => {
    setUser([]);
    const table = new ServerWrittenTable();
    expect(auth().canAccess('query', [table, {}])).toBe(true);
    expect(auth().canAccess('get', [table, { id: 'x' }])).toBe(true);
    expect(auth().canAccess('getRowCount', [table, {}])).toBe(true);
    expect(auth().canAccess('insert', [table, { title: 't' }])).toBe(false);
    expect(auth().canAccess('update', [table, { id: 'x', title: 't' }])).toBe(false);
    expect(auth().canAccess('delete', [table, { id: 'x' }])).toBe(false);
  });

  it('admin: writes allowed on a server-written table', () => {
    setUser(['admin']);
    const table = new ServerWrittenTable();
    expect(auth().canAccess('insert', [table, { title: 't' }])).toBe(true);
    expect(auth().canAccess('update', [table, { id: 'x', title: 't' }])).toBe(true);
    expect(auth().canAccess('delete', [table, { id: 'x' }])).toBe(true);
  });

  it('delete requires the delete grant — a query-only table is not deletable', () => {
    setUser([]);
    const table = new ReadOnlyTable();
    expect(auth().canAccess('query', [table, {}])).toBe(true);
    expect(auth().canAccess('delete', [table, { id: 'x' }])).toBe(false);
  });
});

describe('TableServiceAuth — serviceProtectedColumns', () => {
  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  });

  it('rejects a service insert that sets a protected column, with a clean ServiceError', () => {
    setUser([]);
    const table = new ProtectedColumnTable();
    // The rejection must be a ServiceError (name-tagged — instanceof is unreliable across the
    // service package's compile target) so ServiceRouter returns its message verbatim as the 400.
    let thrown: any;
    try {
      auth().canAccess('insert', [table, { title: 't', owner: 'someone' }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.name).toBe('ServiceError');
    expect(thrown?.message).toBe("Column 'owner' cannot be written via the db service on table: protected_column_test");
  });

  it('rejects a service update that sets a protected column', () => {
    setUser([]);
    const table = new ProtectedColumnTable();
    expect(() => auth().canAccess('update', [table, { id: 'x', owner: 'someone' }])).toThrow(
      "Column 'owner' cannot be written via the db service"
    );
  });

  it('allows service writes that leave the protected column absent or null', () => {
    setUser([]);
    const table = new ProtectedColumnTable();
    expect(auth().canAccess('insert', [table, { title: 't' }])).toBe(true);
    expect(auth().canAccess('insert', [table, { title: 't', owner: null }])).toBe(true);
    expect(auth().canAccess('update', [table, { id: 'x', title: 't2', owner: undefined }])).toBe(true);
  });

  it('never gates reads', () => {
    setUser([]);
    const table = new ProtectedColumnTable();
    expect(auth().canAccess('query', [table, { owner: 'someone' }])).toBe(true);
  });
});
