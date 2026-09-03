/**
 * @jest-environment jsdom
 *
 * The desktop record-table card OWNS its overflow (founder finding 2026-09-02, the Migrations
 * admin table: the header row's background painted past the card's rounded edges on the left
 * and right). Mechanism: the card is a flex item whose automatic minimum width is its table's
 * min-content, and nothing clipped at its radius — a table wider than the page (narrow window,
 * zoom, a wide column declaration) grew the card past its container instead of the table's own
 * scroller absorbing the width. Pinned here as the card's computed rules (jsdom lays nothing
 * out): the card is capped at its container's width, may shrink below its content, and clips
 * at its radius — so the header and body columns share the card's inner box, always.
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

const rows: User[] = [{ id: 'u-1', email: 'a@n3xa.io' } as User];

const mockDb = {
  query: jest.fn(async () => rows),
  getRowCount: jest.fn(async () => rows.length),
};

jest.mock('@proteinjs/db', () => ({
  ...jest.requireActual('@proteinjs/db'),
  getDb: () => mockDb,
  tableByName: (name: string) => {
    if (name !== 'user') {
      throw new Error(`no such table: ${name}`);
    }
    return new UserTable();
  },
}));

// import AFTER the mock so the page module binds the mocked db seams
import { recordTablePage } from '../src/pages/RecordTablePage';

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

// Desktop: the phone line is never matched.
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

describe('RecordTablePage desktop card overflow', () => {
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
    const Page = recordTablePage.component as React.ComponentType<any>;
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <Page urlParams={{ name: 'user' }} />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    for (let i = 0; i < 5 && !document.body.textContent?.includes('a@n3xa.io'); i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };

  it('the card is capped at its container, may shrink below its table, and clips at its radius', async () => {
    await mount();
    const card = document.querySelector('.MuiPaper-root');
    expect(card).not.toBeNull();
    const css = cssFor(card as Element);
    expect(css).toMatch(/max-width:\s*100%/);
    expect(css).toMatch(/min-width:\s*0/);
    expect(css).toMatch(/overflow:\s*hidden/);
    // The table's own scroller still owns scrolling inside the card (the header stays sticky).
    const scroller = document.querySelector('[data-table-scroll-container]');
    expect(scroller).not.toBeNull();
    expect(cssFor(scroller as Element)).toMatch(/overflow:\s*auto/);
  });
});
