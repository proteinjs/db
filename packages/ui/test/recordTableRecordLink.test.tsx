/**
 * @jest-environment jsdom
 *
 * The record-link seam (`Table.ui.recordTable.recordLink`): a table whose rows have their OWN
 * page instead of the generic record form. The record table links each row THERE (replacing the
 * generic form link) and draws neither the New button nor the selection Delete button — a row
 * with its own page has no generic create/delete story, and the seam decides that, not the
 * table's auth doors. Non-declaring tables keep the auth-derived affordances exactly as they are
 * (the bite: same doors, same admin, both buttons back).
 */
import React from 'react';
import { Sync } from '@mui/icons-material';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { StaticTableLoader } from '@proteinjs/ui';
import { Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import { RecordTable } from '../src/table/RecordTable';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).IntersectionObserver = StubIntersectionObserver;

// The exact UserAuth instance TableAuth consults (per-package installs — resolve THROUGH db).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UserAuth } = require(
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require.resolve('@proteinjs/user-auth', { paths: [require('path').dirname(require.resolve('@proteinjs/db'))] })
);

const setUser = (roles: string[]) => {
  (UserAuth as any).userRepo = { getUser: () => ({ email: 'admin@test.local', roles }) };
};
const setMapping = (mapping: { [permission: string]: string[] }) => {
  (UserAuth as any).permissionRolesMapping = { getRoles: (permission: string) => mapping[permission] };
};

interface Account extends Record {
  email: string;
}

/**
 * The declaring shape: full doors (so the auth derivation WOULD hand an admin both buttons) plus
 * a declared per-row page. Every affordance difference in this suite is the seam's doing.
 */
class OwnPageTable extends Table<Account> {
  public name = 'account';
  public auth: Table<Account>['auth'] = {
    db: { all: { permission: 'users' } },
    service: { all: { permission: 'users' } },
  };
  public ui: Table<Account>['ui'] = {
    recordTable: {
      recordLink: (row) => `/account/${row.id}?section=admin`,
    },
  };
  public columns = withRecordColumns<Account>({
    email: new StringColumn('email'),
  });
}

/** The same doors, no declaration — the control. */
class GenericFormTable extends Table<Account> {
  public name = 'member';
  public auth: Table<Account>['auth'] = {
    db: { all: { permission: 'users' } },
    service: { all: { permission: 'users' } },
  };
  public columns = withRecordColumns<Account>({
    email: new StringColumn('email'),
  });
}

const rows: Account[] = [{ id: 'acct-1', email: 'a@n3xa.io' } as Account];

/** Reads the router's live location out into the DOM so a click's outcome is assertable. */
const LocationProbe = () => {
  const location = useLocation();
  return <div data-location={`${location.pathname}${location.search}`} />;
};

const currentLocation = () => document.querySelector('[data-location]')?.getAttribute('data-location');

describe('RecordTable — the record-link seam', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setMapping({ users: ['admin'] });
    setUser(['admin']);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    (UserAuth as any).userRepo = undefined;
    (UserAuth as any).permissionRolesMapping = undefined;
  });

  const mount = async (table: Table<Account>) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/record/table?name=' + table.name]}>
            <LocationProbe />
            <RecordTable
              table={table}
              tableLoader={new StaticTableLoader(rows, undefined as any)}
              columns={['email']}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    for (let i = 0; i < 5 && !document.body.textContent?.includes('a@n3xa.io'); i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(document.body.textContent).toContain('a@n3xa.io');
  };

  /** The row-click gesture the base Table expects: a pointerdown that anchors the click intent, then the click. */
  const clickRow = async () => {
    const row = document.querySelector('tbody tr');
    expect(row).not.toBeNull();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    // the row action resolves a promise before navigating
    for (let i = 0; i < 5 && currentLocation() === '/record/table'; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  const createButton = () => document.querySelector('button[aria-label^="Create"]');
  const selectRowCheckbox = () => document.querySelector('input[aria-label="Select row"]');

  it('a declared recordLink is where the row click goes — not the generic record form', async () => {
    await mount(new OwnPageTable());

    await clickRow();

    expect(currentLocation()).toBe('/account/acct-1?section=admin');
  });

  it('a declaring table draws no New button and no selection Delete — even for an admin the doors open for', async () => {
    await mount(new OwnPageTable());

    expect(createButton()).toBeNull();
    // With no actionable buttons the selection column has nothing to serve either.
    expect(selectRowCheckbox()).toBeNull();
  });

  it('the same doors WITHOUT the declaration keep both affordances — the seam hides them, not the doors', async () => {
    await mount(new GenericFormTable());

    expect(createButton()).not.toBeNull();
    expect(selectRowCheckbox()).not.toBeNull();
  });

  it('a declaring table still honors an explicit buttons prop', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <RecordTable
              table={new OwnPageTable()}
              tableLoader={new StaticTableLoader(rows, undefined as any)}
              columns={['email']}
              buttons={[
                {
                  name: 'Sync accounts',
                  icon: Sync,
                  visibility: { showWhenRowsSelected: true, showWhenNoRowsSelected: true },
                  onClick: async () => undefined,
                },
              ]}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    for (let i = 0; i < 5 && !document.body.textContent?.includes('a@n3xa.io'); i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(document.querySelector('button[aria-label="Sync accounts"]')).not.toBeNull();
    expect(createButton()).toBeNull();
  });
});
