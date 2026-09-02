/**
 * @jest-environment jsdom
 *
 * The desktop record-table card CONTAINS its header (founder finding 2026-09-02, REOPENED: "the
 * header background is clearly covering the border of the card"). The header cells are opaque and
 * sticky by design — rows scroll under them — so whatever they paint reaches the card's edge. The
 * framework's half of containment is that the header can never paint OUTSIDE the card's padding
 * box: the card (the radius owner) clips at its own box, the header lives inside the card's scroll
 * container, and nothing between the header cell and the card offsets it sideways — no negative
 * margins, no left/right offsets, no transforms. Pinned as computed rules (jsdom lays nothing out).
 *
 * The theme's half — the card's hairline drawn as a BORDER, so the padding box (this clip) lies
 * inside it and an opaque edge-flush child cannot cover it — is pinned where the theme lives:
 * util-ui's card-edge tokens and the app's admin surface theme.
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

const px = (value: string): number => (value === '' || value === 'auto' || value === 'none' ? 0 : parseFloat(value));

describe('RecordTablePage desktop card contains its header', () => {
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

  it('the header cell is opaque and sticky INSIDE the card’s scroll container, and the card clips at its own box', async () => {
    await mount();
    const card = document.querySelector('.MuiPaper-root') as HTMLElement;
    const scroller = document.querySelector('[data-table-scroll-container]') as HTMLElement;
    const headerCell = document.querySelector('thead th') as HTMLElement;
    expect(card).not.toBeNull();
    expect(scroller).not.toBeNull();
    expect(headerCell).not.toBeNull();
    expect(card.contains(scroller)).toBe(true);
    expect(scroller.contains(headerCell)).toBe(true);

    // The radius owner owns the clip: children are bounded to the card's padding box (jsdom
    // exposes the `overflow` shorthand it cascaded, not the longhands).
    expect(window.getComputedStyle(card).overflow).toBe('hidden');

    // The header paints an opaque fill (rows scroll under it) and sticks to the scroller's top —
    // exactly the child that reaches the card's edge, which is why the edge must be a border.
    const cellStyle = window.getComputedStyle(headerCell);
    expect(cellStyle.position).toBe('sticky');
    expect(cellStyle.top).toBe('0px');
    expect(cellStyle.backgroundColor).not.toBe('');
    expect(cellStyle.backgroundColor).not.toBe('transparent');
    expect(cellStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  it('nothing between the header cell and the card offsets the header sideways (its box ⊆ the card’s padding box)', async () => {
    await mount();
    const card = document.querySelector('.MuiPaper-root') as HTMLElement;
    const headerCell = document.querySelector('thead th') as HTMLElement;
    // Every sideways offset an element could carry, collected as violations so a failure names
    // the element and the rule (no negative margins/offsets, no transforms).
    const violations: string[] = [];
    let node: HTMLElement | null = headerCell;
    let walked = 0;
    while (node && node !== card) {
      const cs = window.getComputedStyle(node);
      const tag = node.tagName.toLowerCase();
      for (const [prop, value] of Object.entries({
        marginLeft: cs.marginLeft,
        marginRight: cs.marginRight,
        left: cs.left,
        right: cs.right,
      })) {
        if (px(value) < 0) {
          violations.push(`${tag} ${prop}: ${value}`);
        }
      }
      if (cs.transform && cs.transform !== 'none') {
        violations.push(`${tag} transform: ${cs.transform}`);
      }
      node = node.parentElement;
      walked++;
    }
    expect(violations).toEqual([]);
    // The walk reached the card (never bailed at the document root).
    expect(node).toBe(card);
    expect(walked).toBeGreaterThan(0);
  });
});
