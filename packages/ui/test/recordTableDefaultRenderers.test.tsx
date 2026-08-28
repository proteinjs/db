/**
 * @jest-environment jsdom
 *
 * RecordTable's polished defaults (the admin-surface polish rev). Contracts as OUTCOMES:
 *  1. Column pick is tiered meaningful-data, not schema order: identity strings → status-like →
 *     booleans → references → rest, hidden columns never picked, long-text demoted; capped at
 *     five + created/updated.
 *  2. Booleans render the check/dash grammar (no ✅/❌ emoji).
 *  3. DateTime values render humanized with the precise absolute on the title.
 *  4. Status-like short strings render as the quiet chip.
 *  5. References render as a LINK to the referenced record's form — short id immediately,
 *     enriched to the record's name once resolution lands.
 *  6. Numeric columns right-align.
 */
import React from 'react';
import moment from 'moment';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { StaticTableLoader } from '@proteinjs/ui';
import {
  BooleanColumn,
  DateTimeColumn,
  IntegerColumn,
  Record,
  ReferenceColumn,
  StringColumn,
  Table,
  withRecordColumns,
} from '@proteinjs/db';
import { RecordTable, defaultRecordTableColumns } from '../src/table/RecordTable';
import { clearReferenceNameCache } from '../src/table/ReferenceCellValue';

// ReferenceCellValue resolves through Reference.get(); the fake resolves user-9 to a named
// record so the enrichment path is observable without a db.
jest.mock('@proteinjs/db', () => {
  const actual = jest.requireActual('@proteinjs/db');
  class FakeReference {
    constructor(
      public _table: string,
      public _id?: string
    ) {}
    async get() {
      if (this._id === 'user-9') {
        return { id: 'user-9', name: 'Brent Test' };
      }
      throw new Error('not visible');
    }
  }
  return { ...actual, Reference: FakeReference };
});

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

interface Member extends Record {
  secret: string | null;
  notes: string;
  verified: boolean;
  invitedBy: any;
  email: string;
  status: string;
  loginCount: number;
  lastSeen: moment.Moment;
}

class MemberTable extends Table<Member> {
  public name = 'admin_test_member';
  public columns = withRecordColumns<Member>({
    // schema order is deliberately adversarial: the tiers must reorder it
    secret: new StringColumn('secret', { ui: { hidden: true } }),
    notes: new StringColumn('notes', {}, 4000),
    verified: new BooleanColumn('verified'),
    invitedBy: new ReferenceColumn('invited_by', 'user', false),
    email: new StringColumn('email'),
    status: new StringColumn('status'),
    loginCount: new IntegerColumn('login_count'),
    lastSeen: new DateTimeColumn('last_seen'),
  });
}

const lastSeen = moment('2026-05-04 14:30:00', 'YYYY-MM-DD HH:mm:ss');

const row: Member = {
  id: 'member-1',
  secret: 'never-shown',
  notes: 'a long note',
  verified: true,
  invitedBy: { _table: 'user', _id: 'user-9' },
  email: 'brent+test@n3xa.io',
  status: 'active',
  loginCount: 12,
  lastSeen,
  created: moment('2026-01-02T03:04:05.000Z'),
  updated: moment('2026-02-03T04:05:06.000Z'),
} as Member;

describe('defaultRecordTableColumns (meaningful-data tiers)', () => {
  it('picks identity → status → booleans → references, skips hidden, demotes long text, caps at five + created/updated', () => {
    const columns = defaultRecordTableColumns(new MemberTable());
    expect(columns).toEqual(['email', 'status', 'verified', 'invitedBy', 'loginCount', 'created', 'updated']);
  });

  it('compound identity names promote too (userEmail leads a session-shaped table)', () => {
    class SessionishTable extends Table<any> {
      public name = 'admin_test_sessionish';
      public columns = withRecordColumns<any>({
        sessionId: new StringColumn('session_id'),
        session: new StringColumn('serialized_session', {}, 4000),
        userEmail: new StringColumn('user_email'),
      });
    }
    const columns = defaultRecordTableColumns(new SessionishTable());
    expect(columns[0]).toBe('userEmail');
    // the long-text blob demotes behind the short columns
    expect(columns.indexOf('session')).toBeGreaterThan(columns.indexOf('sessionId'));
  });

  it('name leads when the table has one', () => {
    class NamedTable extends Table<any> {
      public name = 'admin_test_named';
      public columns = withRecordColumns<any>({
        email: new StringColumn('email'),
        name: new StringColumn('name'),
      });
    }
    const columns = defaultRecordTableColumns(new NamedTable());
    expect(columns[0]).toBe('name');
    expect(columns).toContain('email');
  });
});

describe('RecordTable default renderers', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    clearReferenceNameCache();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const mount = async (columns?: (keyof Member)[]) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <RecordTable<Member>
              table={new MemberTable()}
              tableLoader={
                new StaticTableLoader([row], { dataKey: `default-renderers-${Math.random()}`, dataQueryKey: 'all' })
              }
              hideButtons
              {...(columns ? { columns } : {})}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const cellFor = (index: number) => container.querySelectorAll('tbody td')[index] as HTMLElement;

  it('booleans render check/dash, datetimes humanized with absolute title, status as the chip', async () => {
    await mount(['verified', 'lastSeen', 'status']);
    expect(cellFor(0).querySelector('svg')).not.toBeNull();
    expect(cellFor(0).textContent).not.toContain('✅');

    expect(cellFor(1).textContent).toBe('May 4, 2026');
    const titled = cellFor(1).querySelector('[title]') as HTMLElement;
    expect(titled.getAttribute('title')).toBe(lastSeen.format('ddd, MMM D YYYY, h:mm:ss A'));

    const chip = cellFor(2);
    expect(chip.textContent).toBe('active');
    // the chip carries its tone dot (an inner span before the text)
    expect(chip.querySelectorAll('span span').length).toBeGreaterThan(0);
  });

  it('references render as a link to the record form — short id first, the name once resolved', async () => {
    await mount(['invitedBy']);
    const link = cellFor(0).querySelector('a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('/record/form?table=user&record=user-9');

    // resolution lands: the short id enriches to the referenced record's name
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(cellFor(0).textContent).toBe('Brent Test');
  });

  it('numeric columns right-align', async () => {
    await mount(['loginCount']);
    expect(cellFor(0).className).toContain('MuiTableCell-alignRight');
  });
});
