/**
 * @jest-environment jsdom
 *
 * Auth-derived record-table affordances (founder admin review, v1.22: "no + button for
 * migrations", "no + on the session table"): the create and delete buttons DERIVE from the
 * table's declared auth doors — an operation the declaration doesn't open for the current
 * user draws no affordance, because the act could only end in a refused save. A UI act rides
 * the service RPC and DbService's inner Db re-checks the db api as the calling user, so an
 * affordance requires BOTH doors. Tables with no auth block keep the historic default
 * (admin-only break-glass — both buttons for admin, none for anyone else).
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
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
  (UserAuth as any).userRepo = { getUser: () => ({ email: 'user@test.local', roles }) };
};
const setMapping = (mapping: { [permission: string]: string[] }) => {
  (UserAuth as any).permissionRolesMapping = { getRoles: (permission: string) => mapping[permission] };
};

interface Session extends Record {
  userEmail: string;
}

/** The session shape: query-only doors — rows are system-written; no write door exists for anyone. */
class QueryOnlyTable extends Table<Session> {
  public name = 'session';
  public auth: Table<Session>['auth'] = {
    db: { query: { permission: 'sessions' } },
    service: { query: { permission: 'sessions' } },
  };
  public columns = withRecordColumns<Session>({
    userEmail: new StringColumn('user_email'),
  });
}

/** Full doors on the 'users' permission — both affordances belong. */
class FullDoorsTable extends Table<Session> {
  public name = 'member';
  public auth: Table<Session>['auth'] = {
    db: { all: { permission: 'users' } },
    service: { all: { permission: 'users' } },
  };
  public columns = withRecordColumns<Session>({
    userEmail: new StringColumn('user_email'),
  });
}

/**
 * Service door open, db door closed: DbService's inner Db re-checks the db api as the calling
 * user, so this shape's insert still ends refused — the affordance must require BOTH doors.
 */
class AsymmetricDoorsTable extends Table<Session> {
  public name = 'half_open';
  public auth: Table<Session>['auth'] = {
    db: { query: { permission: 'users' } },
    service: { all: { permission: 'users' } },
  };
  public columns = withRecordColumns<Session>({
    userEmail: new StringColumn('user_email'),
  });
}

/** No auth block: the historic admin-only default. */
class NoAuthBlockTable extends Table<Session> {
  public name = 'legacy_thing';
  public columns = withRecordColumns<Session>({
    userEmail: new StringColumn('user_email'),
  });
}

const rows: Session[] = [{ id: 's-1', userEmail: 'a@n3xa.io' } as Session];

describe('RecordTable — auth-derived affordances', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setMapping({ sessions: ['staff'], users: ['staff'] });
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

  const mount = async (table: Table<Session>) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <RecordTable table={table} tableLoader={new StaticTableLoader(rows, undefined as any)} />
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

  const createButton = () => document.querySelector('button[aria-label^="Create"]');
  const selectRowCheckbox = () => document.querySelector('input[aria-label="Select row"]');

  it('query-only doors: no create button, no row selection/delete — even for break-glass admin', async () => {
    setUser(['admin']);
    await mount(new QueryOnlyTable());

    expect(createButton()).toBeNull();
    // With no actionable buttons the selection column has nothing to serve either.
    expect(selectRowCheckbox()).toBeNull();
  });

  it('full doors: both affordances for a consumer-mapped permission holder', async () => {
    setUser(['staff']);
    await mount(new FullDoorsTable());

    expect(createButton()).not.toBeNull();
    expect(selectRowCheckbox()).not.toBeNull();
  });

  it('full doors: no affordances for a user the doors do not open for', async () => {
    setUser(['ops-team']);
    await mount(new FullDoorsTable());

    expect(createButton()).toBeNull();
    expect(selectRowCheckbox()).toBeNull();
  });

  it('a service door without its db half is not an affordance — the inner re-check would refuse the act', async () => {
    setUser(['staff']);
    await mount(new AsymmetricDoorsTable());

    expect(createButton()).toBeNull();
    expect(selectRowCheckbox()).toBeNull();
  });

  it('no auth block: the historic admin-only default keeps both buttons for admin', async () => {
    setUser(['admin']);
    await mount(new NoAuthBlockTable());

    expect(createButton()).not.toBeNull();
    expect(selectRowCheckbox()).not.toBeNull();
  });

  it('no auth block: nothing for a non-admin', async () => {
    setUser(['staff']);
    await mount(new NoAuthBlockTable());

    expect(createButton()).toBeNull();
    expect(selectRowCheckbox()).toBeNull();
  });
});
