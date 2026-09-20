/**
 * @jest-environment jsdom
 *
 * A record table loads a page of rows ONCE.
 *
 * The defect: the record table page fetched the same first page of rows three times on every
 * mount. The page defined its table as a component INSIDE its own render, so every render of the
 * page was a new component type and React unmounted and remounted the whole table. The rows are
 * an infinite query, and an infinite query whose last observer leaves mid-flight is cancelled and
 * reverted (its result is thrown away) — so each remount while the first fetch was in flight
 * issued the same row query again, and each remount after it landed refetched the stale page.
 * A page container that re-renders twice while it settles (form factor, session, chrome) made
 * that three identical queries within a few milliseconds — and every later parent render threw
 * away the table's scroll position, selection and settled columns with it.
 *
 * What is pinned here, as outcomes (row queries that reached the db, DOM identity):
 *  - one mount = one fetch of page 1, however often the page's parent renders meanwhile;
 *  - a parent render after the rows landed fetches nothing and keeps the SAME table element;
 *  - the next page of an infinite table = one fetch of that page;
 *  - a page change on a paginated table = one fetch of that page;
 *  - a sort change = one fetch of page 1 under the new sort, and the rows on screen are the new
 *    sort's rows — never the previous sort's page served for it;
 *  - the page moving to a different table = one fetch of THAT table's page 1, in a fresh table.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { Record, SortCriteria, StringColumn, Table, withRecordColumns } from '@proteinjs/db';

interface User extends Record {
  email: string;
}

class UserTable extends Table<User> {
  public name = 'user';
  public columns = withRecordColumns<User>({
    email: new StringColumn('email'),
  });
}

class TeamTable extends Table<User> {
  public name = 'team';
  public columns = withRecordColumns<User>({
    email: new StringColumn('email'),
  });
}

const TOTAL_ROWS = 35;

type RowQuery = { table?: string; start: number; end: number; sort: string };
const rowQueries: RowQuery[] = [];

/** A db whose row query takes a moment, like a real one — a remount can land while it is in flight. */
const mockDb = {
  query: jest.fn(async (table: any, qb: any) => {
    const { start, end } = qb.graph.node(qb.paginationNodeId);
    const criteria = (qb.getSortCriteria() as SortCriteria<User>[])[0];
    const sort = `${String(criteria.field)}:${criteria.desc ? 'desc' : 'asc'}`;
    // The user table's queries read as before; another table's name rides its queries and rows.
    const named = table.name === 'user' ? {} : { table: table.name as string };
    const owner = table.name === 'user' ? '' : `${table.name}-`;
    rowQueries.push({ ...named, start, end, sort });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rows: User[] = [];
    for (let index = start; index < Math.min(end, TOTAL_ROWS); index++) {
      rows.push({ id: `u-${index}`, email: `${owner}${sort}-${index}@example.com` } as User);
    }
    return rows;
  }),
  getRowCount: jest.fn(async () => TOTAL_ROWS),
};

jest.mock('@proteinjs/db', () => ({
  ...jest.requireActual('@proteinjs/db'),
  getDb: () => mockDb,
  tableByName: (name: string) => {
    if (name === 'user') {
      return new UserTable();
    }
    if (name === 'team') {
      return new TeamTable();
    }
    throw new Error(`no such table: ${name}`);
  },
}));

// import AFTER the mock so the modules bind the mocked db seams
// The reflection graph: whatever the record table resolves from it is there to find.
import '../generated';
import { recordTablePage } from '../src/pages/RecordTablePage';
import { RecordTable } from '../src/table/RecordTable';
import { QueryTableLoader } from '../src/table/QueryTableLoader';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** An IntersectionObserver the test drives: `sentinelEntersView()` is the user reaching the end. */
class DrivenIntersectionObserver {
  static live: DrivenIntersectionObserver[] = [];
  constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
  observe() {
    DrivenIntersectionObserver.live.push(this);
  }
  unobserve() {
    DrivenIntersectionObserver.live = DrivenIntersectionObserver.live.filter((observer) => observer !== this);
  }
  disconnect() {
    this.unobserve();
  }
  static sentinelEntersView() {
    for (const observer of [...DrivenIntersectionObserver.live]) {
      observer.callback([{ isIntersecting: true }]);
    }
  }
}
(globalThis as any).IntersectionObserver = DrivenIntersectionObserver;

beforeAll(() => {
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
});

describe('a record table loads a page once', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    rowQueries.length = 0;
    DrivenIntersectionObserver.live = [];
    // The defaults an app's client carries (stale at once, refetch on mount) — only retries off.
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    client.clear();
  });

  const render = async (children: React.ReactNode) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>{children}</MemoryRouter>
        </QueryClientProvider>
      );
    });
  };

  /** Everything in flight lands, and whatever it set off lands too. */
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    }
  };

  /** One render of the page by its parent — a fresh props object every time, as a container passes. */
  const renderPage = (name = 'user') => {
    const Page = recordTablePage.component as React.ComponentType<any>;
    return render(<Page urlParams={{ name }} />);
  };

  const firstPage: RowQuery = { start: 0, end: 10, sort: 'updated:desc' };

  it('the page: one mount is one fetch of page 1, however often its parent renders while it loads', async () => {
    await renderPage();
    await renderPage();
    await renderPage();
    await settle();

    expect(rowQueries).toEqual([firstPage]);
    expect(document.body.textContent).toContain('updated:desc-0@example.com');
  });

  it('the page: a parent render after the rows landed fetches nothing and keeps the same table', async () => {
    await renderPage();
    await settle();
    expect(rowQueries).toEqual([firstPage]);
    const table = document.querySelector('table');
    const scroller = document.querySelector('[data-table-scroll-container]');
    expect(table).toBeTruthy();

    await renderPage();
    await settle();
    await renderPage();
    await settle();

    expect(rowQueries).toEqual([firstPage]);
    // The same elements, not look-alikes: a remounted table drops its scroll position, its
    // selection and its settled columns, and paints its loading face again.
    expect(document.querySelector('table')).toBe(table);
    expect(document.querySelector('[data-table-scroll-container]')).toBe(scroller);
  });

  it('an infinite table: reaching the end is one fetch of the next page', async () => {
    await renderPage();
    await settle();
    expect(rowQueries).toEqual([firstPage]);

    await act(async () => {
      DrivenIntersectionObserver.sentinelEntersView();
    });
    // The pager re-observes its sentinel once a fetch starts, and a fresh observer reports at
    // once: that report, with the page still in flight, asks for nothing more.
    await act(async () => {
      DrivenIntersectionObserver.sentinelEntersView();
    });
    await settle();

    expect(rowQueries).toEqual([firstPage, { start: 10, end: 20, sort: 'updated:desc' }]);
    expect(document.body.textContent).toContain('updated:desc-0@example.com');
    expect(document.body.textContent).toContain('updated:desc-19@example.com');
  });

  it('a paginated table: a page change is one fetch of that page', async () => {
    const table = new UserTable();
    await render(<RecordTable table={table} pagination />);
    await settle();
    expect(rowQueries).toEqual([firstPage]);

    const nextPage = document.querySelector('button[aria-label="Go to next page"]') as HTMLButtonElement;
    expect(nextPage).toBeTruthy();
    await act(async () => {
      nextPage.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();

    expect(rowQueries).toEqual([firstPage, { start: 10, end: 20, sort: 'updated:desc' }]);
    expect(document.body.textContent).toContain('updated:desc-10@example.com');
    expect(document.body.textContent).not.toContain('updated:desc-0@example.com');
  });

  it('a sort change is one fetch of page 1 under the new sort, and its rows are the ones on screen', async () => {
    const table = new UserTable();
    const sortedBy = (field: keyof User, desc: boolean) =>
      render(<RecordTable table={table} tableLoader={new QueryTableLoader(table, undefined, [{ field, desc }])} />);

    await sortedBy('updated', true);
    await settle();
    expect(rowQueries).toEqual([firstPage]);

    await sortedBy('email', false);
    await settle();

    expect(rowQueries).toEqual([firstPage, { start: 0, end: 10, sort: 'email:asc' }]);
    expect(document.body.textContent).toContain('email:asc-0@example.com');
    // Never the previous sort's page standing in for this one.
    expect(document.body.textContent).not.toContain('updated:desc-0@example.com');
  });
  it("the page moving to a different table is one fetch of that table's page 1, in a fresh table", async () => {
    await renderPage('user');
    await settle();
    const userTable = document.querySelector('table');

    await renderPage('team');
    await settle();

    expect(rowQueries).toEqual([firstPage, { table: 'team', start: 0, end: 10, sort: 'updated:desc' }]);
    const cells = Array.from(document.querySelectorAll('td')).map((cell) => cell.textContent);
    expect(cells).toContain('team-updated:desc-0@example.com');
    // None of the table it left.
    expect(cells).not.toContain('updated:desc-0@example.com');
    // A different table starts over (its own first page, unscrolled, nothing selected).
    expect(document.querySelector('table')).not.toBe(userTable);
  });
});
