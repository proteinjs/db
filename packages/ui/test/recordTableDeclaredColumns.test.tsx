/**
 * @jest-environment jsdom
 *
 * Declared row columns (founder admin review, v1.22): a table that declares
 * `Table.ui.recordTable.columns` owns the generic record table's row pick — the framework
 * renders what tables declare. The declaration exists for two real cases:
 *   - a column a human scans for that the default five-column pick drops (the migration
 *     ledger's `duration`);
 *   - a column with no business in a row scan (an invite's redeemable `token`, a session's
 *     serialized cookie blob) that stays on the record FORM, so `ui.hidden` (which hides it
 *     everywhere) is the wrong tool.
 * `created`/`updated` still join at the end — the record family's shared face.
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

// The exact UserAuth instance TableAuth consults (per-package installs — resolve THROUGH db),
// so the derived-affordance seam sees a logged-in admin and button derivation stays out of
// this suite's way (it has its own suite: recordTableDerivedAffordances).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UserAuth } = require(
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require.resolve('@proteinjs/user-auth', { paths: [require('path').dirname(require.resolve('@proteinjs/db'))] })
);

interface Invite extends Record {
  email: string;
  token: string;
  invitedBy: string;
}

/** Declares its row columns; `token` stays off the row scan (still a real, visible column). */
class DeclaringInviteTable extends Table<Invite> {
  public name = 'invite';
  public columns = withRecordColumns<Invite>({
    email: new StringColumn('email'),
    token: new StringColumn('token'),
    invitedBy: new StringColumn('invited_by'),
  });
  public ui: Table<Invite>['ui'] = {
    recordTable: {
      columns: ['email', 'invitedBy'],
    },
  };
}

/** The same schema, no declaration — the default pick still owns undeclared tables. */
class UndeclaredInviteTable extends Table<Invite> {
  public name = 'invite';
  public columns = withRecordColumns<Invite>({
    email: new StringColumn('email'),
    token: new StringColumn('token'),
    invitedBy: new StringColumn('invited_by'),
  });
}

const rows: Invite[] = [
  { id: 'i-1', email: 'a@n3xa.io', token: 'tok-secret-a1b2c3', invitedBy: 'founder@n3xa.io' } as Invite,
];

describe('RecordTable — declared row columns', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (UserAuth as any).userRepo = { getUser: () => ({ email: 'admin@test.local', roles: ['admin'] }) };
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
  });

  const mount = async (table: Table<Invite>) => {
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

  const headerTexts = () =>
    Array.from(document.querySelectorAll('th'))
      .map((th) => th.textContent?.trim() ?? '')
      .filter((text) => text.length > 0);

  it('renders exactly the declared columns, in order, with created/updated appended', async () => {
    await mount(new DeclaringInviteTable());

    expect(headerTexts()).toEqual(['Email', 'Invited by', 'Created', 'Updated']);
  });

  it('keeps the undeclared column off the rows — value included — while the record form still owns the full record', async () => {
    await mount(new DeclaringInviteTable());

    expect(headerTexts()).not.toContain('Token');
    expect(document.body.textContent).not.toContain('tok-secret-a1b2c3');
  });

  it('undeclared tables keep the meaningful-data default pick', async () => {
    await mount(new UndeclaredInviteTable());

    // The default pick surfaces every visible column here (only three candidates).
    expect(headerTexts()).toEqual(expect.arrayContaining(['Email', 'Token', 'Invited by']));
    expect(document.body.textContent).toContain('tok-secret-a1b2c3');
  });
});
