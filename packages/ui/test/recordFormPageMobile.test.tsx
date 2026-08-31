/**
 * @jest-environment jsdom
 *
 * RecordFormPage's phone layout (founder ruling 2026-08-31: admin forms take the full mobile
 * view). Below the phone line the page is FULL-BLEED: no FormPage card, no page gutters — the
 * form spans the shell's page column full-height and scrolls itself, keeping only its own
 * content inset (fields never touch the glass; the card's inset was the only thing keeping
 * them off it). Desktop keeps the house FormPage card.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import '../generated';

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
  get: jest.fn(async () => undefined),
  insert: jest.fn(async (table: any, record: any) => record),
  update: jest.fn(async (table: any, record: any) => record),
};

jest.mock('@proteinjs/db', () => ({
  ...jest.requireActual('@proteinjs/db'),
  getDbService: () => mockDbService,
  tableByName: (name: string) => {
    if (name !== 'user') {
      throw new Error(`no such table: ${name}`);
    }
    return new UserTable();
  },
}));

// import AFTER the mock so the page module binds the mocked db seams
import { recordFormPage } from '../src/pages/RecordFormPage';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

describe('RecordFormPage phone layout', () => {
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
    const Page = recordFormPage.component as React.ComponentType<any>;
    await act(async () => {
      root.render(
        <MemoryRouter>
          {/* new-record form: nothing to load, the layout is the subject here */}
          <Page urlParams={{ table: 'user' }} />
        </MemoryRouter>
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it('phone: full-bleed — no card, no gutters; the form spans the page column and scrolls itself', async () => {
    phoneMode = true;
    await mount();
    // No card chrome anywhere on the page (the founder's cards-on-mobile defect).
    expect(document.querySelector('.MuiPaper-root')).toBeNull();
    const host = document.querySelector('[data-phone-fullbleed]') as HTMLElement;
    expect(host).toBeTruthy();
    const hostCss = cssFor(host);
    // Full height of the shell's page column; a long form scrolls inside it.
    expect(hostCss).toContain('flex-grow: 1');
    expect(hostCss).toContain('min-height: 0');
    expect(hostCss).toContain('overflow: auto');
    // The form keeps its own content inset (the fields never touch the glass).
    expect(hostCss).toContain('padding: 16px');
    // The form itself renders inside.
    expect(document.body.textContent).toContain('Email');
  });

  it('desktop: the FormPage card stays unchanged', async () => {
    phoneMode = false;
    await mount();
    expect(document.querySelector('.MuiPaper-root')).toBeTruthy();
    expect(document.querySelector('[data-phone-fullbleed]')).toBeNull();
    expect(document.body.textContent).toContain('Email');
  });
});
