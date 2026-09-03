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
 * - the operation doors (`canPerform`) are byte-for-byte the pre-refactor semantics: within a
 *   declared block an undeclared operation stays closed to everyone, admin included.
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
