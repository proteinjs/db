/**
 * @jest-environment jsdom
 *
 * TablesPage (the dev table browser). Its phone layout (founder ruling 2026-08-31: admin tables
 * take the full mobile view): below the phone line the page is FULL-BLEED: no FormPage card, no
 * gutters — the summary table fills the shell's page column and rows present as Table's phone
 * card face. Desktop keeps the house FormPage card. And its list: each row is a count the DbService
 * RPC answers, so the page lists only the tables the viewer may query through it — a table whose
 * query door the viewer does not clear has no row (the admin passkeys' tables declare `query: []`,
 * a door that admits nobody, the admin included).
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

/**
 * The count runs the RPC's two doors as DbService does: the router's service gate
 * (`TableServiceAuth`), then the inner Db's db-api re-check as the calling user (`Db.getRowCount`).
 * A refused count rejects, as the RPC's does.
 */
const mockDbService = {
  getRowCount: jest.fn(async (table: Table<any>) => {
    if (!new TableServiceAuth().canAccess('getRowCount', [table])) {
      throw new Error(`Not authorized: ${table.name}`);
    }
    new TableAuth().canQuery(table);
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

class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
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
  it('a table whose query door the viewer does not clear on either api has no row; the others keep their counts', async () => {
    phoneMode = false;
    mockTables = [new UserTable(), new ServiceSealedTable(), new DbSealedTable(), new NoteTable()];
    await mount();
    const rows = Array.from(document.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)
    );
    expect(rows).toEqual([
      ['user', '3'],
      ['note', '5'],
    ]);
  });
});
