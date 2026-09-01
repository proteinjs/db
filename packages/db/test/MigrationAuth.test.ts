import { UserAuth } from '@proteinjs/user-auth';
// Deep dist path on purpose: the package index doesn't export the auth gate (it is framework
// plumbing), but the test must exercise the REAL gate, not a re-implementation of its rules.
import { ServiceAuth } from '@proteinjs/service/dist/src/ServiceAuth';
import { Method } from '@proteinjs/reflection';
import { MigrationRunner } from '../src/MigrationRunner';
import { MigrationTable } from '../src/tables/MigrationTable';
import { TableAuth } from '../src/auth/TableAuth';

/**
 * Migrations ride the 'dev' PERMISSION (plans/ROLES_AND_PERMISSIONS.md decision 4), not the
 * admin role: the MigrationRunner service and the migration table doors resolve 'dev' through
 * the consumer's PermissionRolesMapping, so a consumer-mapped dev-role holder can run
 * migrations while admin still passes everything as break-glass. The mapping deliberately names
 * a role that is NOT the slug ('dev-crew') to prove the indirection, mirroring the
 * TableServiceAuth suite's stubbing idiom.
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

const canRunMigrations = () => {
  const method = new Method('runMigration', undefined, true, false, false, false, 'public', []);
  return ServiceAuth.canRunService(new MigrationRunner(), method, ['some-migration-id']);
};

describe('migrations ride the dev permission', () => {
  beforeEach(() => {
    setMapping({ dev: ['dev-crew'] });
  });

  afterEach(() => {
    (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
    (UserAuth as unknown as UserAuthInternals).permissionRolesMapping = undefined;
  });

  it(`a consumer-mapped dev-role holder can run migrations and use the migration table's doors`, () => {
    setUser(['dev-crew']);
    expect(canRunMigrations()).toBe(true);

    const auth = new TableAuth();
    const table = new MigrationTable();
    // The record-table page reads via the service api; the runner updates via the db api.
    for (const api of ['db', 'service'] as const) {
      expect(() => auth.canQuery(table, api)).not.toThrow();
      expect(() => auth.canUpdate(table, api)).not.toThrow();
    }
  });

  it('a permissionless user is denied the service and both table doors', () => {
    setUser(['ops-team']);
    expect(canRunMigrations()).toBe(false);

    const auth = new TableAuth();
    const table = new MigrationTable();
    for (const api of ['db', 'service'] as const) {
      expect(() => auth.canQuery(table, api)).toThrow('User is not authorized to query table: migration');
      expect(() => auth.canUpdate(table, api)).toThrow('User is not authorized to update records in table: migration');
    }
  });

  it('admin passes everything as break-glass', () => {
    setUser(['admin']);
    expect(canRunMigrations()).toBe(true);

    const auth = new TableAuth();
    const table = new MigrationTable();
    for (const api of ['db', 'service'] as const) {
      expect(() => auth.canQuery(table, api)).not.toThrow();
      expect(() => auth.canUpdate(table, api)).not.toThrow();
    }
  });

  it('insert has no door — for anyone, break-glass included: ledger rows are born from source declarations only', () => {
    const auth = new TableAuth();
    const table = new MigrationTable();
    for (const roles of [['dev-crew'], ['admin']]) {
      setUser(roles);
      for (const api of ['db', 'service'] as const) {
        expect(() => auth.canInsert(table, api)).toThrow(
          'User is not authorized to insert records into table: migration'
        );
        // The capability read the record surfaces derive affordances from agrees with the gate.
        expect(auth.canPerform(table, 'insert', api)).toBe(false);
      }
    }
  });

  it('delete keeps its dev door (ledger hygiene stays possible)', () => {
    setUser(['dev-crew']);
    const auth = new TableAuth();
    const table = new MigrationTable();
    for (const api of ['db', 'service'] as const) {
      expect(() => auth.canDelete(table, api)).not.toThrow();
      expect(auth.canPerform(table, 'delete', api)).toBe(true);
    }
  });
});
