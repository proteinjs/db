import { UserAuth } from '@proteinjs/user-auth';
import { Logger } from '@proteinjs/logger';
import { Table } from '../src/Table';
import { withRecordColumns, Record } from '../src/Record';
import { StringColumn } from '../src/Columns';
import { TableServiceAuth } from '../src/auth/TableServiceAuth';
import { TransactionRunner } from '../src/transaction/TransactionRunner';

/**
 * Covers the service-path (RPC) table auth gate:
 * - per-operation `service` grants (query stays open while writes are role-gated)
 * - `canDelete` honoring the `delete` grant (not `query` — the pre-fix behavior let any
 *   authenticated user delete from read-only tables)
 * - `auth.serviceProtectedColumns`: columns that can never be SET via the service path,
 *   rejected with a clean `ServiceError` (message passes through to the client verbatim)
 * - denials cross the wire as a `ServiceError` naming the table and operation — a denied query
 *   must be distinguishable from an empty one at the surface that shows it (the admin Sessions
 *   table read "no rows" while every query behind it was denied, 2026-08). A boolean `false`
 *   here collapses into the generic run-service denial.
 *
 * - a transaction's operations are held to the same gate, each to its own table's door: the
 *   transaction runner's service declaration asks `TableServiceAuth` for every operation of a request
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

/**
 * Mirrors the admin tables surfaced in the settings menu (user, invite, session, migration):
 * NO auth block at all — the default-deny contract makes them admin-only through the service path.
 */
class NoAuthTable extends Table<Doc> {
  public name = 'no_auth_test';
  public columns = withRecordColumns<Doc>({
    title: new StringColumn('title'),
    owner: new StringColumn('owner'),
  });
}

/**
 * Mirrors the user table's shape: doors keyed to an abstract PERMISSION resolved through the
 * consumer mapping, with a service-protected column reserved to a dedicated service.
 */
class PermissionGatedTable extends Table<Doc> {
  public name = 'permission_gated_test';
  public auth: Table<Doc>['auth'] = {
    service: {
      query: { permission: 'users' },
      update: { permission: 'users' },
    },
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

type UserAuthInternals = {
  userRepo?: { getUser: () => { email: string; roles: string[] } };
  permissionRolesMapping?: { getRoles: (permission: string) => string[] | undefined };
};

const setUser = (roles: string[]) => {
  (UserAuth as unknown as UserAuthInternals).userRepo = {
    getUser: () => ({ email: 'user@test.local', roles }),
  };
};

const setMapping = (mapping: { [permission: string]: string[] }) => {
  (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = {
    getRoles: (permission: string) => mapping[permission],
  };
};

const auth = () => new TableServiceAuth();

/** A denial must be a client-safe ServiceError naming the table and operation. */
const expectDenied = (fn: () => unknown, message: string) => {
  let thrown: any;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown?.name).toBe('ServiceError');
  expect(thrown?.message).toBe(message);
};

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
    expectDenied(
      () => auth().canAccess('insert', [table, { title: 't' }]),
      'User is not authorized to insert records into table: server_written_test'
    );
    expectDenied(
      () => auth().canAccess('update', [table, { id: 'x', title: 't' }]),
      'User is not authorized to update records in table: server_written_test'
    );
    expectDenied(
      () => auth().canAccess('delete', [table, { id: 'x' }]),
      'User is not authorized to delete records from table: server_written_test'
    );
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
    expectDenied(
      () => auth().canAccess('delete', [table, { id: 'x' }]),
      'User is not authorized to delete records from table: read_only_test'
    );
  });
});

describe('TableServiceAuth — permission-keyed doors (the user table shape)', () => {
  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
    (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = undefined;
  });

  it(`grants a holder of the consumer's mapped role; denies without the role`, () => {
    const table = new PermissionGatedTable();
    setMapping({ users: ['support'] });

    setUser(['support']);
    expect(auth().canAccess('query', [table, {}])).toBe(true);
    expect(auth().canAccess('update', [table, { id: 'x', title: 't' }])).toBe(true);

    setUser(['dev']);
    expectDenied(
      () => auth().canAccess('query', [table, {}]),
      'User is not authorized to query table: permission_gated_test'
    );
  });

  it('denies everyone but admin when no mapping is registered (default deny)', () => {
    const table = new PermissionGatedTable();
    setUser(['support']);
    expectDenied(
      () => auth().canAccess('query', [table, {}]),
      'User is not authorized to query table: permission_gated_test'
    );

    setUser(['admin']);
    expect(auth().canAccess('query', [table, {}])).toBe(true);
  });

  it('operations without a grant stay closed even for permission holders (and admin)', () => {
    const table = new PermissionGatedTable();
    setMapping({ users: ['support'] });
    setUser(['support']);
    expectDenied(
      () => auth().canAccess('insert', [table, { title: 't' }]),
      'User is not authorized to insert records into table: permission_gated_test'
    );
    // An auth block with no grant for the operation is a deliberate lock, not an admin default —
    // the audit-table shape (role_grant_event) depends on this.
    setUser(['admin']);
    expectDenied(
      () => auth().canAccess('delete', [table, { id: 'x' }]),
      'User is not authorized to delete records from table: permission_gated_test'
    );
  });

  it('the protected column stays unwritable even for a permission holder with the update grant', () => {
    const table = new PermissionGatedTable();
    setMapping({ users: ['support'] });
    setUser(['support']);
    expectDenied(
      () => auth().canAccess('update', [table, { id: 'x', owner: 'someone' }]),
      "Column 'owner' cannot be written via the db service on table: permission_gated_test"
    );
  });
});

describe('TableServiceAuth — default deny (no auth block)', () => {
  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  });

  it('denies every operation to an authenticated non-admin, naming the table (never a silent false)', () => {
    setUser([]);
    const table = new NoAuthTable();
    const queryDenial = 'User is not authorized to query table: no_auth_test';
    expectDenied(() => auth().canAccess('query', [table, {}]), queryDenial);
    expectDenied(() => auth().canAccess('get', [table, { id: 'x' }]), queryDenial);
    expectDenied(() => auth().canAccess('getRowCount', [table, {}]), queryDenial);
    expectDenied(
      () => auth().canAccess('insert', [table, { title: 't' }]),
      'User is not authorized to insert records into table: no_auth_test'
    );
    expectDenied(
      () => auth().canAccess('update', [table, { id: 'x', title: 't' }]),
      'User is not authorized to update records in table: no_auth_test'
    );
    expectDenied(
      () => auth().canAccess('delete', [table, { id: 'x' }]),
      'User is not authorized to delete records from table: no_auth_test'
    );
  });

  it('allows every operation for an admin', () => {
    setUser(['admin']);
    const table = new NoAuthTable();
    expect(auth().canAccess('query', [table, {}])).toBe(true);
    expect(auth().canAccess('get', [table, { id: 'x' }])).toBe(true);
    expect(auth().canAccess('getRowCount', [table, {}])).toBe(true);
    expect(auth().canAccess('insert', [table, { title: 't' }])).toBe(true);
    expect(auth().canAccess('update', [table, { id: 'x', title: 't' }])).toBe(true);
    expect(auth().canAccess('delete', [table, { id: 'x' }])).toBe(true);
  });

  it('the multi-row insert is a server-side door only: the service refuses it, admin included', () => {
    setUser(['admin']);
    const table = new NoAuthTable();
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      expect(auth().canAccess('insertMany', [table, [{ title: 't' }]])).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('asking whether a row is within the caller’s reach is a call for the server’s own code: the service refuses it, admin included, and a transaction does not queue it', async () => {
    setUser(['admin']);
    const table = new NoAuthTable();
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      expect(auth().canAccess('canReach', [table, 'x'])).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
    const notQueued = [{ name: 'canReach', args: [table, 'x'] }] as unknown as Parameters<TransactionRunner['run']>[0];
    await expect(new TransactionRunner().run(notQueued)).rejects.toThrow(
      /a transaction runs only the operations a transaction queues/
    );
  });
});

describe('TableServiceAuth — updateArrayMembership / updatePreserving (update parity)', () => {
  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  });

  const membership = (columnPropertyName: string) => ({
    recordId: 'x',
    columnPropertyName,
    ops: [{ op: 'add', id: 'm1', afterId: null }],
  });

  it('both verbs are gated by the update grant: denied for non-admin, allowed for admin', () => {
    setUser([]);
    const table = new ServerWrittenTable();
    const updateDenial = 'User is not authorized to update records in table: server_written_test';
    expectDenied(() => auth().canAccess('updateArrayMembership', [table, membership('title')]), updateDenial);
    expectDenied(
      () =>
        auth().canAccess('updatePreserving', [
          table,
          { id: 'x', title: 't' },
          [{ columnPropertyName: 'title', paths: ['content'] }],
        ]),
      updateDenial
    );

    setUser(['admin']);
    expect(auth().canAccess('updateArrayMembership', [table, membership('title')])).toBe(true);
    expect(
      auth().canAccess('updatePreserving', [
        table,
        { id: 'x', title: 't' },
        [{ columnPropertyName: 'title', paths: ['content'] }],
      ])
    ).toBe(true);
  });

  it('default deny (no auth block): both verbs denied for non-admin with the update denial', () => {
    setUser([]);
    const table = new NoAuthTable();
    const updateDenial = 'User is not authorized to update records in table: no_auth_test';
    expectDenied(() => auth().canAccess('updateArrayMembership', [table, membership('title')]), updateDenial);
    expectDenied(() => auth().canAccess('updatePreserving', [table, { id: 'x', title: 't' }, []]), updateDenial);
  });

  it('updateArrayMembership cannot target a serviceProtectedColumn (its payload names the column, not record fields)', () => {
    setUser([]);
    const table = new ProtectedColumnTable();
    expectDenied(
      () => auth().canAccess('updateArrayMembership', [table, membership('owner')]),
      "Column 'owner' cannot be written via the db service on table: protected_column_test"
    );
    expect(auth().canAccess('updateArrayMembership', [table, membership('title')])).toBe(true);
  });

  it('updatePreserving runs the record-shaped protected-column check on its payload', () => {
    setUser([]);
    const table = new ProtectedColumnTable();
    expectDenied(
      () => auth().canAccess('updatePreserving', [table, { id: 'x', owner: 'someone' }, []]),
      "Column 'owner' cannot be written via the db service on table: protected_column_test"
    );
    expect(auth().canAccess('updatePreserving', [table, { id: 'x', title: 't', owner: null }, []])).toBe(true);
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

describe('a transaction is held, operation by operation, to each table’s own service door', () => {
  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  });

  /**
   * Whether the service layer would run a transaction of these operations for the session's person, read from the
   * runner's own declaration the way the service layer reads any service's: its `canAccess` when it declares one,
   * else its door for every signed-in person.
   */
  const mayRun = (ops: unknown[]): boolean => {
    const declared = new TransactionRunner().serviceMetadata?.auth as {
      canAccess?: (methodName: string, args: unknown[]) => boolean;
      allUsers?: boolean;
    };
    return declared.canAccess ? declared.canAccess('run', [ops]) : !!declared.allUsers && UserAuth.isLoggedIn();
  };

  it('a person with no role: each write to a server-written table is refused in the door’s own words, and one such operation refuses the whole request', () => {
    setUser([]);
    const table = new ServerWrittenTable();
    expectDenied(
      () => mayRun([{ name: 'insert', args: [table, { title: 't' }] }]),
      'User is not authorized to insert records into table: server_written_test'
    );
    for (const update of [
      { name: 'update', args: [table, { id: 'x', title: 't' }] },
      { name: 'updatePreserving', args: [table, { id: 'x', title: 't' }, []] },
      { name: 'updateArrayMembership', args: [table, { recordId: 'x', columnPropertyName: 'title', ops: [] }] },
    ]) {
      expectDenied(() => mayRun([update]), 'User is not authorized to update records in table: server_written_test');
    }
    expectDenied(
      () => mayRun([{ name: 'delete', args: [table, { id: 'x' }] }]),
      'User is not authorized to delete records from table: server_written_test'
    );
    expectDenied(
      () =>
        mayRun([
          { name: 'update', args: [new ProtectedColumnTable(), { id: 'x', title: 't' }] },
          { name: 'delete', args: [table, { id: 'x' }] },
        ]),
      'User is not authorized to delete records from table: server_written_test'
    );
  });

  it('a column a table closes to a service write is closed to a transaction’s write', () => {
    setUser([]);
    const table = new ProtectedColumnTable();
    for (const write of [
      { name: 'insert', args: [table, { title: 't', owner: 'someone' }] },
      { name: 'update', args: [table, { id: 'x', owner: 'someone' }] },
      { name: 'updatePreserving', args: [table, { id: 'x', owner: 'someone' }, []] },
      { name: 'updateArrayMembership', args: [table, { recordId: 'x', columnPropertyName: 'owner', ops: [] }] },
    ]) {
      expectDenied(
        () => mayRun([write]),
        "Column 'owner' cannot be written via the db service on table: protected_column_test"
      );
    }
  });

  it('what the doors admit is run: a person’s writes to a table open to them, an admin’s to a server-written one; with no one signed in, nothing', () => {
    const open = new ProtectedColumnTable();
    const aPersonsWrites = [
      { name: 'insert', args: [open, { title: 't' }] },
      { name: 'update', args: [open, { id: 'x', title: 't2', owner: null }] },
      { name: 'delete', args: [open, { id: 'x' }] },
    ];
    setUser([]);
    expect(mayRun(aPersonsWrites)).toBe(true);
    setUser(['admin']);
    expect(mayRun([{ name: 'insert', args: [new ServerWrittenTable(), { title: 't' }] }])).toBe(true);
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
    expect(mayRun([])).toBe(false);
    expect(mayRun(aPersonsWrites)).toBe(false);
  });
});
