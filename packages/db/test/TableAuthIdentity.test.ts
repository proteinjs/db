import { UserAuth } from '@proteinjs/user-auth';
import { Table } from '../src/Table';
import { withRecordColumns, Record } from '../src/Record';
import { StringColumn } from '../src/Columns';
import { TableAuth } from '../src/auth/TableAuth';

/**
 * `TableAuth.identityAllows` — the one identity grammar (`'public' | 'authenticated' | roles[] |
 * { permission }`) read for a DECLARED UI affordance that carries its own grant (a record form's
 * declared panels, `Table.auth.ui`). Outcomes pinned:
 * - each identity form resolves against the current user; 'admin' is break-glass throughout;
 * - an UNDECLARED identity is admin-only (default-deny made explicit), never open;
 * - it fails CLOSED when no user can be resolved;
 * - the operation doors (`canPerform`) keep the declared-block semantics: within a declared block
 *   an undeclared operation stays closed to everyone, admin included — unless the table's SERVICE
 *   block names that door, which the db door then mirrors (the last describe).
 *
 * `UserAuth` reads from a static repo; tests stub it directly per identity — no server needed.
 */

interface Doc extends Record {
  title: string;
}

class QueryOnlyTable extends Table<Doc> {
  public name = 'identity_query_only_test';
  public auth: Table<Doc>['auth'] = {
    db: { query: 'authenticated' },
  };
  public columns = withRecordColumns<Doc>({ title: new StringColumn('title') });
}

const setUser = (roles: string[], email = 'user@test.local') => {
  (UserAuth as any).userRepo = { getUser: () => ({ email, roles }) };
};
const setGuest = () => {
  (UserAuth as any).userRepo = { getUser: () => ({ email: 'guest', roles: [] }) };
};
const setMapping = (mapping: { [permission: string]: string[] }) => {
  (UserAuth as any).permissionRolesMapping = { getRoles: (permission: string) => mapping[permission] };
};

describe('TableAuth.identityAllows', () => {
  beforeEach(() => {
    setMapping({ usage: ['usage'] });
  });

  afterEach(() => {
    (UserAuth as any).userRepo = undefined;
    (UserAuth as any).permissionRolesMapping = undefined;
  });

  test("'public' admits anyone, including a guest", () => {
    setGuest();
    expect(new TableAuth().identityAllows('public')).toBe(true);
  });

  test("'authenticated' admits a signed-in user and refuses a guest", () => {
    setUser([]);
    expect(new TableAuth().identityAllows('authenticated')).toBe(true);
    setGuest();
    expect(new TableAuth().identityAllows('authenticated')).toBe(false);
  });

  test('a roles list admits a holder of at least one role', () => {
    setUser(['ops']);
    expect(new TableAuth().identityAllows(['users', 'ops'])).toBe(true);
    setUser(['dev']);
    expect(new TableAuth().identityAllows(['users', 'ops'])).toBe(false);
  });

  test('a permission identity resolves through the consumer mapping; admin is break-glass', () => {
    setUser(['usage']);
    expect(new TableAuth().identityAllows({ permission: 'usage' })).toBe(true);
    setUser(['users']);
    expect(new TableAuth().identityAllows({ permission: 'usage' })).toBe(false);
    setUser(['admin']);
    expect(new TableAuth().identityAllows({ permission: 'usage' })).toBe(true);
  });

  test('an undeclared identity is admin-only, never open', () => {
    setUser(['usage', 'users', 'ops']);
    expect(new TableAuth().identityAllows(undefined)).toBe(false);
    setUser(['admin']);
    expect(new TableAuth().identityAllows(undefined)).toBe(true);
  });

  test('fails closed when no user can be resolved', () => {
    (UserAuth as any).userRepo = {
      getUser: () => {
        throw new Error('no session');
      },
    };
    expect(new TableAuth().identityAllows('authenticated')).toBe(false);
    expect(new TableAuth().identityAllows({ permission: 'usage' })).toBe(false);
  });
});

describe('TableAuth operation doors keep their declared-block semantics', () => {
  afterEach(() => {
    (UserAuth as any).userRepo = undefined;
    (UserAuth as any).permissionRolesMapping = undefined;
  });

  test('a declared operation opens to its identity', () => {
    setUser([]);
    expect(new TableAuth().canPerform(new QueryOnlyTable(), 'query')).toBe(true);
  });

  test('within a declared block an undeclared operation stays closed — admin included', () => {
    setUser(['admin']);
    expect(new TableAuth().canPerform(new QueryOnlyTable(), 'insert')).toBe(false);
    setUser([]);
    expect(new TableAuth().canPerform(new QueryOnlyTable(), 'insert')).toBe(false);
  });
});

/**
 * The RPC runs BOTH doors — the service gate (`TableServiceAuth`) and then the inner `Db`'s
 * db-api re-check as the calling user — so a db door a table leaves UNDECLARED mirrors the door
 * its service block declares for the same operation. "db doors mirror service doors" was a rule
 * tables hand-copied; the owner derives it now: fifteen consumer tables opened `['admin']` writes
 * on the service api over a query-only db block, and every one refused the admin at the inner
 * check in the gate's own words — the gate admitted them, the re-check behind it did not, two
 * verdicts for one caller. One-way: a service block that omits the door keeps the lock (the
 * session / audit-trail pattern — no write door on either api, break-glass included), and a table
 * with no service block keeps its db block as written (the pin above).
 */
class ReadOpenWriteAdminTable extends Table<Doc> {
  public name = 'identity_read_open_write_admin_test';
  public auth: Table<Doc>['auth'] = {
    db: { query: 'authenticated' },
    service: { query: 'authenticated', insert: ['admin'], update: ['admin'], delete: ['admin'] },
  };
  public columns = withRecordColumns<Doc>({ title: new StringColumn('title') });
}

class LockedLedgerTable extends Table<Doc> {
  public name = 'identity_locked_ledger_test';
  public auth: Table<Doc>['auth'] = {
    db: { query: { permission: 'ledger' } },
    service: { query: { permission: 'ledger' } },
  };
  public columns = withRecordColumns<Doc>({ title: new StringColumn('title') });
}

describe('TableAuth — an undeclared db door mirrors the declared service door', () => {
  beforeEach(() => {
    setMapping({ ledger: ['ledger'] });
  });

  afterEach(() => {
    (UserAuth as any).userRepo = undefined;
    (UserAuth as any).permissionRolesMapping = undefined;
  });

  test("an admin's write clears the ['admin'] service door AND the db-api re-check behind it", () => {
    setUser(['admin']);
    const table = new ReadOpenWriteAdminTable();
    expect(() => new TableAuth().canUpdate(table, 'service')).not.toThrow();
    expect(() => new TableAuth().canUpdate(table)).not.toThrow();
    expect(() => new TableAuth().canInsert(table)).not.toThrow();
    expect(() => new TableAuth().canDelete(table)).not.toThrow();
    expect(new TableAuth().canPerform(table, 'update', 'db')).toBe(true);
  });

  test('a signed-in non-admin is refused by name on both apis; the read door stays open', () => {
    setUser(['ledger']);
    const table = new ReadOpenWriteAdminTable();
    expect(() => new TableAuth().canUpdate(table, 'service')).toThrow(
      'User is not authorized to update records in table: identity_read_open_write_admin_test'
    );
    expect(() => new TableAuth().canUpdate(table)).toThrow(
      'User is not authorized to update records in table: identity_read_open_write_admin_test'
    );
    expect(() => new TableAuth().canQuery(table)).not.toThrow();
  });

  test('a guest is refused every door', () => {
    setGuest();
    const table = new ReadOpenWriteAdminTable();
    expect(() => new TableAuth().canQuery(table)).toThrow(
      'User is not authorized to query table: identity_read_open_write_admin_test'
    );
    expect(() => new TableAuth().canUpdate(table)).toThrow();
    expect(() => new TableAuth().canInsert(table, 'service')).toThrow();
  });

  test('one-way: a service block that omits the door keeps the lock on both apis, break-glass included', () => {
    setUser(['admin']);
    const table = new LockedLedgerTable();
    expect(new TableAuth().canPerform(table, 'update', 'service')).toBe(false);
    expect(new TableAuth().canPerform(table, 'update', 'db')).toBe(false);
    expect(() => new TableAuth().canUpdate(table)).toThrow(
      'User is not authorized to update records in table: identity_locked_ledger_test'
    );
    expect(() => new TableAuth().canInsert(table, 'service')).toThrow();
    expect(() => new TableAuth().canQuery(table)).not.toThrow();
  });

  test('a table with no service block keeps its db block as written — admin included', () => {
    setUser(['admin']);
    expect(new TableAuth().canPerform(new QueryOnlyTable(), 'update', 'db')).toBe(false);
    expect(() => new TableAuth().canUpdate(new QueryOnlyTable())).toThrow(
      'User is not authorized to update records in table: identity_query_only_test'
    );
  });
});
