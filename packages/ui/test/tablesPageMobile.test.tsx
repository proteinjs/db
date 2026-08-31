/**
 * @jest-environment jsdom
 *
 * TablesPage's (dev table browser) phone layout (founder ruling 2026-08-31: admin tables take
 * the full mobile view). Below the phone line the page is FULL-BLEED: no FormPage card, no
 * gutters — the summary table fills the shell's page column and rows present as Table's phone
 * card face. Desktop keeps the house FormPage card.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';

interface User extends Record {
  email: string;
}

class UserTable extends Table<User> {
  public name = 'user';
  public columns = withRecordColumns<User>({
    email: new StringColumn('email'),
  });
}

const mockDbService = {
  getRowCount: jest.fn(async () => 3),
};

jest.mock('@proteinjs/db', () => ({
  ...jest.requireActual('@proteinjs/db'),
  getTables: () => [new UserTable()],
  getDbService: () => mockDbService,
}));

// import AFTER the mock so the page module binds the mocked db seams
import { tablesPage } from '../src/pages/TablesPage';

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

describe('TablesPage phone layout', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
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
