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
 *   block names that door for the admin role alone, which the db door then mirrors (the last two
 *   describes).
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

/**
 * A door declared as an EMPTY roles list on both apis (the admin passkeys' tables, user_passkey and
 * auth_challenge): a declaration, not an omission, so it is not the undeclared admin default.
 */
class EmptyDoorTable extends Table<Doc> {
  public name = 'identity_empty_door_test';
  public auth: Table<Doc>['auth'] = {
    db: { query: [] },
    service: { query: [] },
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

  test('a declared empty door admits nobody — the admin included, on both apis', () => {
    const table = new EmptyDoorTable();
    for (const roles of [['admin'], ['ops'], []]) {
      setUser(roles);
      expect(new TableAuth().canPerform(table, 'query', 'service')).toBe(false);
      expect(new TableAuth().canPerform(table, 'query', 'db')).toBe(false);
    }
    setUser(['admin']);
    expect(() => new TableAuth().canQuery(table, 'service')).toThrow(
      'User is not authorized to query table: identity_empty_door_test'
    );
    expect(() => new TableAuth().canQuery(table)).toThrow(
      'User is not authorized to query table: identity_empty_door_test'
    );
  });
});

/**
 * The RPC runs BOTH doors — the service gate (`TableServiceAuth`) and then the inner `Db`'s
 * db-api re-check as the calling user — so a db door a table leaves UNDECLARED mirrors the door
 * its service block declares for the same operation, where that door admits the admin role ALONE
 * (declared exactly `['admin']`). "db doors mirror service doors" was a rule tables hand-copied;
 * the owner derives it now: consumer tables opened `['admin']` writes on the service api over a
 * query-only db block, and every one refused the admin at the inner check in the gate's own words
 * — the gate admitted them, the re-check behind it did not, two verdicts for one caller. One-way:
 * a service block that omits the door keeps the lock (the session / audit-trail pattern — no
 * write door on either api, break-glass included), and a table with no service block keeps its
 * db block as written (the pin above). A service door declared any wider than the admin role is
 * the next describe's: it mirrors nothing.
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

describe("TableAuth — an undeclared db door mirrors the declared ['admin'] service door", () => {
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

/**
 * Role privilege and the reach of a permission are different things: the mirror carries the
 * admin's break-glass across the two apis, never a wider identity. The service block here opens
 * three writes to identities wider than the admin role — a permission, a non-admin role, every
 * signed-in user — over a query-only db block, and none of them is mirrored: the gate admits the
 * holder and the db door behind it stays shut, exactly as before the mirror existed. A table that
 * means a wider identity to write through the db api declares that door at the db block itself.
 */
class WiderServiceDoorsTable extends Table<Doc> {
  public name = 'identity_wider_service_doors_test';
  public auth: Table<Doc>['auth'] = {
    db: { query: { permission: 'ledger' } },
    service: {
      query: { permission: 'ledger' },
      update: { permission: 'ledger' },
      insert: ['ledger'],
      delete: 'authenticated',
    },
  };
  public columns = withRecordColumns<Doc>({ title: new StringColumn('title') });
}

/** A service write door the admin role shares with another role: not the admin role alone. */
class SharedRoleDoorTable extends Table<Doc> {
  public name = 'identity_shared_role_door_test';
  public auth: Table<Doc>['auth'] = {
    db: { query: 'authenticated' },
    service: { query: 'authenticated', update: ['admin', 'ledger'] },
  };
  public columns = withRecordColumns<Doc>({ title: new StringColumn('title') });
}

/** The admin-only door named by `all`: the same door, read the way the gate reads it. */
class AllAdminServiceTable extends Table<Doc> {
  public name = 'identity_all_admin_service_test';
  public auth: Table<Doc>['auth'] = {
    db: { query: 'authenticated' },
    service: { all: ['admin'] },
  };
  public columns = withRecordColumns<Doc>({ title: new StringColumn('title') });
}

/** An `['admin']` entry beside an `all` that widens the door to every signed-in user: not admin alone. */
class WidenedByAllTable extends Table<Doc> {
  public name = 'identity_widened_by_all_test';
  public auth: Table<Doc>['auth'] = {
    db: { query: 'authenticated' },
    service: { all: 'authenticated', update: ['admin'] },
  };
  public columns = withRecordColumns<Doc>({ title: new StringColumn('title') });
}

describe('TableAuth — the mirror reaches only a service door that admits the admin role alone', () => {
  beforeEach(() => {
    setMapping({ ledger: ['ledger'] });
  });

  afterEach(() => {
    (UserAuth as any).userRepo = undefined;
    (UserAuth as any).permissionRolesMapping = undefined;
  });

  test('a permission-declared service write with no db door stays shut for the permission holder — the gate admits, the db door does not', () => {
    setUser(['ledger']);
    const table = new WiderServiceDoorsTable();
    expect(new TableAuth().canPerform(table, 'update', 'service')).toBe(true);
    expect(new TableAuth().canPerform(table, 'update', 'db')).toBe(false);
    expect(() => new TableAuth().canUpdate(table)).toThrow(
      'User is not authorized to update records in table: identity_wider_service_doors_test'
    );
    expect(() => new TableAuth().canQuery(table)).not.toThrow();
  });

  test("a non-admin role door and an 'authenticated' door are as shut on the db api as the permission door", () => {
    setUser(['ledger']);
    const table = new WiderServiceDoorsTable();
    expect(new TableAuth().canPerform(table, 'insert', 'service')).toBe(true);
    expect(new TableAuth().canPerform(table, 'insert', 'db')).toBe(false);
    expect(new TableAuth().canPerform(table, 'delete', 'service')).toBe(true);
    expect(new TableAuth().canPerform(table, 'delete', 'db')).toBe(false);
    expect(() => new TableAuth().canInsert(table)).toThrow(
      'User is not authorized to insert records into table: identity_wider_service_doors_test'
    );
  });

  test('a wider service door opens nothing on the db api for the admin either — shut as it was before the mirror', () => {
    setUser(['admin']);
    const table = new WiderServiceDoorsTable();
    expect(new TableAuth().canPerform(table, 'update', 'db')).toBe(false);
    expect(new TableAuth().canPerform(table, 'insert', 'db')).toBe(false);
    expect(new TableAuth().canPerform(table, 'delete', 'db')).toBe(false);
    expect(() => new TableAuth().canUpdate(table)).toThrow(
      'User is not authorized to update records in table: identity_wider_service_doors_test'
    );
  });

  test('a door the admin role shares with another role is not the admin role alone: shut on the db api for both', () => {
    const table = new SharedRoleDoorTable();
    setUser(['admin']);
    expect(new TableAuth().canPerform(table, 'update', 'service')).toBe(true);
    expect(new TableAuth().canPerform(table, 'update', 'db')).toBe(false);
    setUser(['ledger']);
    expect(new TableAuth().canPerform(table, 'update', 'service')).toBe(true);
    expect(new TableAuth().canPerform(table, 'update', 'db')).toBe(false);
  });

  test("the admin-only door may be named by `all`; an `all` that widens the door beside an ['admin'] entry mirrors nothing", () => {
    setUser(['admin']);
    expect(new TableAuth().canPerform(new AllAdminServiceTable(), 'update', 'db')).toBe(true);
    expect(() => new TableAuth().canUpdate(new AllAdminServiceTable())).not.toThrow();
    expect(new TableAuth().canPerform(new WidenedByAllTable(), 'update', 'service')).toBe(true);
    expect(new TableAuth().canPerform(new WidenedByAllTable(), 'update', 'db')).toBe(false);
    setUser(['ledger']);
    expect(new TableAuth().canPerform(new AllAdminServiceTable(), 'update', 'db')).toBe(false);
  });
});

/**
 * A page acting through the service (db-ui's Tables page counting rows, RecordTable's create and
 * delete) rides the DbService RPC, which runs two doors: the service gate (`TableServiceAuth`, the
 * service api) and then the inner Db's re-check as the calling user (the db api). Each table below
 * opens the query door to the admin on one api, the other, or both; the shut door is a declared
 * empty list, the one door that refuses the admin.
 */
class GateOpenReCheckShutTable extends Table<Doc> {
  public name = 'identity_gate_open_recheck_shut_test';
  public auth: Table<Doc>['auth'] = {
    db: { query: [] },
    service: { query: ['admin'] },
  };
  public columns = withRecordColumns<Doc>({ title: new StringColumn('title') });
}

class GateShutReCheckOpenTable extends Table<Doc> {
  public name = 'identity_gate_shut_recheck_open_test';
  public auth: Table<Doc>['auth'] = {
    db: { query: ['admin'] },
    service: { query: [] },
  };
  public columns = withRecordColumns<Doc>({ title: new StringColumn('title') });
}

class BothDoorsOpenTable extends Table<Doc> {
  public name = 'identity_both_doors_open_test';
  public auth: Table<Doc>['auth'] = {
    db: { query: ['admin'] },
    service: { query: ['admin'] },
  };
  public columns = withRecordColumns<Doc>({ title: new StringColumn('title') });
}

describe('TableAuth.canPerformThroughService — a page acting through the service needs both doors', () => {
  afterEach(() => {
    (UserAuth as any).userRepo = undefined;
  });

  test('open at the gate and shut at the re-check answers no, the reverse answers no, both open answers yes', () => {
    setUser(['admin']);
    const auth = new TableAuth();

    const gateOnly = new GateOpenReCheckShutTable();
    expect(auth.canPerform(gateOnly, 'query', 'service')).toBe(true);
    expect(auth.canPerform(gateOnly, 'query', 'db')).toBe(false);
    expect(auth.canPerformThroughService(gateOnly, 'query')).toBe(false);

    const reCheckOnly = new GateShutReCheckOpenTable();
    expect(auth.canPerform(reCheckOnly, 'query', 'service')).toBe(false);
    expect(auth.canPerform(reCheckOnly, 'query', 'db')).toBe(true);
    expect(auth.canPerformThroughService(reCheckOnly, 'query')).toBe(false);

    expect(auth.canPerformThroughService(new BothDoorsOpenTable(), 'query')).toBe(true);
  });
});
