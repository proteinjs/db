/**
 * @jest-environment jsdom
 *
 * RecordTablePage's phone layout (founder ruling 2026-08-31: admin tables take the full mobile
 * view). Below the phone line the page is FULL-BLEED: no Paper card, no page gutters — the
 * table fills the shell's page column (flex-grow against the viewport column, min-height 0 so
 * the table's own scroll container carries the height) and rows present as Table's phone card
 * face. Desktop keeps the deliberate house card (admin round 3): floating fit-content Paper in
 * 32px padding, 80vh cap.
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
// The reflection graph: the record table resolves its table's RecordTableCustomization from it.
import '../generated';
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

describe('RecordTablePage phone layout', () => {
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it('phone: full-bleed — no card, no gutters; the table fills the page column and rows render as the card face', async () => {
    phoneMode = true;
    await mount();
    // No card chrome anywhere on the page (the founder's cards-on-mobile defect).
    expect(document.querySelector('.MuiPaper-root')).toBeNull();
    const host = document.querySelector('[data-phone-fullbleed]') as HTMLElement;
    expect(host).toBeTruthy();
    const hostCss = cssFor(host);
    // Fills the shell's flex page column; the table's own scroll container carries the height.
    expect(hostCss).toContain('flex-grow: 1');
    expect(hostCss).toContain('min-height: 0');
    // No outer padding gutters.
    expect(hostCss).not.toContain('padding');
    expect(document.querySelector('[data-table-phone-face]')).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
    expect(document.body.textContent).toContain('a@n3xa.io');
  });

  it('desktop: the floating fit-content card and the table face stay unchanged', async () => {
    phoneMode = false;
    await mount();
    const paper = document.querySelector('.MuiPaper-root') as HTMLElement;
    expect(paper).toBeTruthy();
    // Fit-content: no bare `width` rule (the card's overflow contract sets `max-width: 100%`,
    // which caps it at the container without stretching it — see recordTablePageCardOverflow).
    expect(cssFor(paper)).not.toMatch(/(^|[^-\w])width: 100%/);
    expect(document.querySelector('[data-phone-fullbleed]')).toBeNull();
    expect(document.querySelector('table')).toBeTruthy();
    expect(document.querySelector('[data-table-phone-face]')).toBeNull();
  });
});
