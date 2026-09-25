import { UserAuth } from '@proteinjs/user-auth';
import { Table } from '../src/Table';
import { withRecordColumns, Record } from '../src/Record';
import { StringColumn } from '../src/Columns';
import { TableAuth } from '../src/auth/TableAuth';
import { TableServiceAuth } from '../src/auth/TableServiceAuth';
import { MigrationTable } from '../src/tables/MigrationTable';

/**
 * A DURABLE table (`Table.durable`) keeps its rows: the delete door is closed on both apis for
 * every caller — break-glass included, whatever `auth` declares — and the refusal is a typed 403
 * that names the table. Everything else about the table's doors is unchanged, and a table that
 * does not declare it keeps its delete doors exactly as declared.
 *
 * The house's rule: the migration ledger's rows could be selected and deleted from the record
 * table in a deployment — they are durable records; the migration table declares it.
 *
 * `UserAuth` reads from a static repo; tests stub it directly per identity — no server needed.
 */

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

interface Entry extends Record {
  title: string;
}

/** Every door open to the 'ledger' permission — the delete door included. */
class OpenLedgerTable extends Table<Entry> {
  public name = 'open_ledger_test';
  public auth: Table<Entry>['auth'] = {
    db: { all: { permission: 'ledger' } },
    service: { all: { permission: 'ledger' } },
  };
  public columns = withRecordColumns<Entry>({
    title: new StringColumn('title'),
  });
}

/** The same doors, declared durable: the declared delete doors do not reopen what durability closes. */
class DurableLedgerTable extends OpenLedgerTable {
  public name = 'durable_ledger_test';
  public durable = true;
}

/** Durable with no auth block at all: admin's break-glass default does not reach delete either. */
class DurableNoAuthTable extends Table<Entry> {
  public name = 'durable_no_auth_test';
  public durable = true;
  public columns = withRecordColumns<Entry>({
    title: new StringColumn('title'),
  });
}

/** What the refusal is, read by shape (the router reads a `ServiceRefusal` the same way). */
const refusalOf = (act: () => unknown): { name?: string; status?: number; message?: string } | undefined => {
  try {
    act();
  } catch (error: any) {
    return { name: error?.name, status: error?.status, message: error?.message };
  }
  return undefined;
};

describe('a durable table keeps its rows', () => {
  beforeEach(() => {
    setMapping({ ledger: ['ledger-keeper'] });
  });

  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
    (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = undefined;
  });

  it('the delete door refuses every caller on both apis — a 403 refusal naming the table, whatever auth declares', () => {
    const auth = new TableAuth();
    for (const table of [new DurableLedgerTable(), new DurableNoAuthTable()]) {
      for (const roles of [['ledger-keeper'], ['admin']]) {
        setUser(roles);
        for (const api of ['db', 'service'] as const) {
          const refusal = refusalOf(() => auth.canDelete(table, api));
          expect(refusal).toEqual({
            name: 'ServiceRefusal',
            status: 403,
            message: `Table ${table.name} is durable: its rows are never deleted`,
          });
          // The capability read the record surfaces derive their acts from agrees with the door.
          expect(auth.canPerform(table, 'delete', api)).toBe(false);
        }
      }
    }
  });

  it('the service door passes the refusal to the caller as it is — not a generic denial, not a failure', () => {
    setUser(['admin']);
    const table = new DurableLedgerTable();
    const refusal = refusalOf(() => new TableServiceAuth().canAccess('delete', [table, { id: 'entry-1' }]));
    expect(refusal).toEqual({
      name: 'ServiceRefusal',
      status: 403,
      message: 'Table durable_ledger_test is durable: its rows are never deleted',
    });
  });

  it('the durable table keeps every other door it declares', () => {
    setUser(['ledger-keeper']);
    const auth = new TableAuth();
    const table = new DurableLedgerTable();
    for (const api of ['db', 'service'] as const) {
      expect(() => auth.canQuery(table, api)).not.toThrow();
      expect(() => auth.canInsert(table, api)).not.toThrow();
      expect(() => auth.canUpdate(table, api)).not.toThrow();
    }
    expect(new TableServiceAuth().canAccess('query', [table, {}])).toBe(true);
    expect(new TableServiceAuth().canAccess('update', [table, { id: 'entry-1', title: 't' }])).toBe(true);
  });

  it('a table that does not declare it keeps its delete doors exactly as declared', () => {
    const auth = new TableAuth();
    const table = new OpenLedgerTable();

    setUser(['ledger-keeper']);
    for (const api of ['db', 'service'] as const) {
      expect(() => auth.canDelete(table, api)).not.toThrow();
      expect(auth.canPerform(table, 'delete', api)).toBe(true);
    }
    expect(new TableServiceAuth().canAccess('delete', [table, { id: 'entry-1' }])).toBe(true);

    setUser(['someone-else']);
    expect(() => auth.canDelete(table, 'service')).toThrow(
      'User is not authorized to delete records from table: open_ledger_test'
    );
  });

  it('the migration ledger is durable', () => {
    setUser(['admin']);
    const table = new MigrationTable();
    const refusal = refusalOf(() => new TableServiceAuth().canAccess('delete', [table, { id: 'migration-1' }]));
    expect(refusal?.status).toBe(403);
    expect(refusal?.message).toBe('Table migration is durable: its rows are never deleted');
  });
});
