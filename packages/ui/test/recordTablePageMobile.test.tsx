/**
 * @jest-environment jsdom
 *
 * RecordTablePage's phone layout (task #53: admin surfaces work on mobile). Below the phone
 * line the page presents the table card full-width with page gutters (the desktop face floats
 * a fit-content Paper in 32px padding — a fixed column grid wider than the screen). Also pins
 * the end-to-end substrate integration: on a phone the page renders Table's card face.
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

  it('phone: the table card spans the page (full-width Paper) and rows render as the card face', async () => {
    phoneMode = true;
    await mount();
    const paper = document.querySelector('.MuiPaper-root') as HTMLElement;
    expect(paper).toBeTruthy();
    expect(cssFor(paper)).toContain('width: 100%');
    expect(document.querySelector('[data-table-phone-face]')).toBeTruthy();
    expect(document.querySelector('table')).toBeNull();
    expect(document.body.textContent).toContain('a@n3xa.io');
  });

  it('desktop: the floating fit-content card and the table face stay unchanged', async () => {
    phoneMode = false;
    await mount();
    const paper = document.querySelector('.MuiPaper-root') as HTMLElement;
    expect(paper).toBeTruthy();
    expect(cssFor(paper)).not.toContain('width: 100%');
    expect(document.querySelector('table')).toBeTruthy();
    expect(document.querySelector('[data-table-phone-face]')).toBeNull();
  });
});
