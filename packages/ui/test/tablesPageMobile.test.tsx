/**
 * @jest-environment jsdom
 *
 * TablesPage (the dev table browser). Its phone layout (founder ruling 2026-08-31: admin tables
 * take the full mobile view): below the phone line the page is FULL-BLEED: no FormPage card, no
 * gutters — the summary table fills the shell's page column and rows present as Table's phone
 * card face. Desktop keeps the house FormPage card. And its list: each row is a count the DbService
 * RPC answers, so the page lists only the tables the viewer may query through it — a table whose
 * query door the viewer does not clear has no row (the admin passkeys' tables declare `query: []`,
 * a door that admits nobody, the admin included). The page asks the owner which tables those are,
 * so a door shut without an empty list counts too. The list is filtered BEFORE it is windowed: the
 * table loads ten rows a window and ends at the first window that returns fewer, so a window that
 * dropped a sealed table after the slice would end the list there. And nothing catches the count:
 * a count that fails for any other reason fails the page as it did before, never a shorter list.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { Record, StringColumn, Table, TableAuth, TableServiceAuth, withRecordColumns } from '@proteinjs/db';

interface User extends Record {
  email: string;
}

class UserTable extends Table<User> {
  public name = 'user';
  public columns = withRecordColumns<User>({
    email: new StringColumn('email'),
  });
}

/** The admin passkeys' door at the service gate: `query: []` admits nobody, the admin included. */
class ServiceSealedTable extends Table<User> {
  public name = 'service_sealed';
  public auth: Table<User>['auth'] = {
    db: { query: ['admin'] },
    service: { query: [] },
  };
  public columns = withRecordColumns<User>({
    email: new StringColumn('email'),
  });
}

/** Open at the service gate, shut at the db-api re-check the RPC runs behind it. */
class DbSealedTable extends Table<User> {
  public name = 'db_sealed';
  public auth: Table<User>['auth'] = {
    db: { query: [] },
    service: { query: ['admin'] },
  };
  public columns = withRecordColumns<User>({
    email: new StringColumn('email'),
  });
}

/**
 * Shut to the admin with no empty list anywhere: the db block declares only an insert door, for
 * another role, so its undeclared query door stays closed, and the service door is wider than
 * admin-only, so nothing mirrors into it. A page that drops only `query: []` doors would list it.
 */
class OpsInsertOnlyTable extends Table<User> {
  public name = 'ops_insert_only';
  public auth: Table<User>['auth'] = {
    db: { insert: ['ops'] },
    service: { query: 'authenticated' },
  };
  public columns = withRecordColumns<User>({
    email: new StringColumn('email'),
  });
}

class NoteTable extends Table<User> {
  public name = 'note';
  public auth: Table<User>['auth'] = {
    db: { query: 'authenticated' },
    service: { query: 'authenticated' },
  };
  public columns = withRecordColumns<User>({
    email: new StringColumn('email'),
  });
}

let mockTables: Table<any>[] = [new UserTable()];
const mockRowCounts: { [tableName: string]: number } = { user: 3, note: 5 };

/** A table the admin may query on both apis (no auth block: the admin default), with its own count. */
const queryableTable = (name: string, rowCount: number): Table<any> => {
  const table = new UserTable();
  table.name = name;
  mockRowCounts[name] = rowCount;
  return table;
};

/** Counts that fail for a reason that is not authorization, by table name. */
let mockCountFailures: { [tableName: string]: Error } = {};

/** A table the admin may query on both apis whose count fails anyway (the database times out). */
const failingCountTable = (name: string, failure: Error): Table<any> => {
  const table = new UserTable();
  table.name = name;
  mockCountFailures[name] = failure;
  return table;
};

/**
 * The count runs the RPC's two doors as DbService does: the router's service gate
 * (`TableServiceAuth`), then the inner Db's db-api re-check as the calling user (`Db.getRowCount`).
 * A refused count rejects, as the RPC's does; so does a count past both doors that fails.
 */
const mockDbService = {
  getRowCount: jest.fn(async (table: Table<any>) => {
    if (!new TableServiceAuth().canAccess('getRowCount', [table])) {
      throw new Error(`Not authorized: ${table.name}`);
    }
    new TableAuth().canQuery(table);
    if (mockCountFailures[table.name]) {
      throw mockCountFailures[table.name];
    }
    return mockRowCounts[table.name] ?? 0;
  }),
};

jest.mock('@proteinjs/db', () => ({
  ...jest.requireActual('@proteinjs/db'),
  getTables: () => mockTables,
  getDbService: () => mockDbService,
}));

// import AFTER the mock so the page module binds the mocked db seams
import { tablesPage } from '../src/pages/TablesPage';

// The exact UserAuth instance TableAuth consults (per-package installs — resolve THROUGH db).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UserAuth } = require(
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require.resolve('@proteinjs/user-auth', { paths: [require('path').dirname(require.resolve('@proteinjs/db'))] })
);

const setUser = (roles: string[]) => {
  (UserAuth as any).userRepo = { getUser: () => ({ email: 'user@test.local', roles }) };
};

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The table's load-more sentinel is watched by an IntersectionObserver; the stub keeps the ones
 * observing so a case can bring the sentinel into view and ask for the next window.
 */
const observing = new Set<StubIntersectionObserver>();
class StubIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe() {
    observing.add(this);
  }
  unobserve() {
    observing.delete(this);
  }
  disconnect() {
    observing.delete(this);
  }
  intersect() {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
(globalThis as any).IntersectionObserver = StubIntersectionObserver;

let phoneMode = true;
beforeAll(() => {
  (window as any).matchMedia = (query: string) => ({
    matches: phoneMode,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
});

/** Emotion under jest injects rules via CSSOM; read the actual styles the classes apply. */
const cssFor = (el: Element): string => {
  const classes = Array.from(el.classList).filter((cls) => cls.startsWith('css-'));
  const out: string[] = [];
  Array.from(document.querySelectorAll('style')).forEach((styleEl) => {
    const rules = styleEl.sheet?.cssRules ?? ([] as unknown as CSSRuleList);
    Array.from(rules).forEach((rule) => {
      if (classes.some((cls) => rule.cssText.includes(`.${cls}`))) {
        out.push(rule.cssText);
      }
    });
  });
  return out.join('\n');
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // The viewer: the admin (the page's 'dev' permission passes for admin as break-glass).
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
  mockTables = [new UserTable()];
  mockCountFailures = {};
  observing.clear();
});

const mount = async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
  const Page = tablesPage.component as React.ComponentType<any>;
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Page />
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** The sentinel scrolls into view: the table asks for its next window. */
const reachTheEnd = async () => {
  await act(async () => {
    Array.from(observing).forEach((observer) => observer.intersect());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const desktopRows = () =>
  Array.from(document.querySelectorAll('tbody tr')).map((row) =>
    Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)
  );

describe('TablesPage phone layout', () => {
  it('phone: full-bleed — no card, no gutters; the summary table fills the page column as the card face', async () => {
    phoneMode = true;
    await mount();
    expect(document.querySelector('.MuiPaper-root')).toBeNull();
    const host = document.querySelector('[data-phone-fullbleed]') as HTMLElement;
    expect(host).toBeTruthy();
    const hostCss = cssFor(host);
    expect(hostCss).toContain('flex-grow: 1');
    expect(hostCss).toContain('min-height: 0');
    expect(hostCss).not.toContain('padding');
    expect(document.querySelector('[data-table-phone-face]')).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
    expect(document.body.textContent).toContain('user');
  });

  it('desktop: the FormPage card stays unchanged', async () => {
    phoneMode = false;
    await mount();
    expect(document.querySelector('.MuiPaper-root')).toBeTruthy();
    expect(document.querySelector('[data-phone-fullbleed]')).toBeNull();
    expect(document.querySelector('table')).toBeTruthy();
    expect(document.querySelector('[data-table-phone-face]')).toBeNull();
  });
});

describe('TablesPage lists only the tables the viewer may query', () => {
  it('a table whose query door the viewer does not clear on either api has no row, BEFORE the list is windowed: the first window is the first ten tables the viewer may query, and the next window still arrives', async () => {
    phoneMode = false;
    // Fifteen registered tables, twelve the viewer may query. The three it may not are among the
    // first ten: two sealed by `query: []`, and one shut with no empty list (only the owner knows).
    mockTables = [
      new UserTable(),
      new ServiceSealedTable(),
      queryableTable('table_01', 11),
      queryableTable('table_02', 12),
      new DbSealedTable(),
      queryableTable('table_03', 13),
      queryableTable('table_04', 14),
      queryableTable('table_05', 15),
      new OpsInsertOnlyTable(),
      queryableTable('table_06', 16),
      queryableTable('table_07', 17),
      queryableTable('table_08', 18),
      new NoteTable(),
      queryableTable('table_09', 19),
      queryableTable('table_10', 20),
    ];
    await mount();
    const firstWindow = [
      ['user', '3'],
      ['table_01', '11'],
      ['table_02', '12'],
      ['table_03', '13'],
      ['table_04', '14'],
      ['table_05', '15'],
      ['table_06', '16'],
      ['table_07', '17'],
      ['table_08', '18'],
      ['note', '5'],
    ];
    expect(desktopRows()).toEqual(firstWindow);

    await reachTheEnd();
    expect(desktopRows()).toEqual([...firstWindow, ['table_09', '19'], ['table_10', '20']]);
  });

  it('a count that fails for a reason that is not authorization fails the page as it did: its load failure shows, never a shorter list', async () => {
    phoneMode = false;
    const failure = new Error('Deadline exceeded while counting rows');
    mockTables = [
      new UserTable(),
      queryableTable('table_01', 11),
      failingCountTable('count_times_out', failure),
      queryableTable('table_02', 12),
    ];
    await mount();
    // One row, the failure: no table's row, so the list never reads as complete without it.
    expect(desktopRows()).toEqual([[expect.stringContaining(failure.message)]]);
  });
});
