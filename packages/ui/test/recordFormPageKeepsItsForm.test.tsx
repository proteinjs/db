/**
 * @jest-environment jsdom
 *
 * The record form page keeps its form across its parent's renders.
 *
 * The same defect the record table page had (recordTableLoadsAPageOnce): the page defined its
 * form as a component INSIDE its own render, so every render of the page was a new component
 * type and React unmounted and remounted the whole form — whatever had been typed into it was
 * gone the next time the page's container rendered (its chrome, its session, a socket event).
 *
 * Pinned as outcomes: what the person typed is still in the same field after the page's parent
 * renders again — and a DIFFERENT table is a different form, with that table's fields (the form
 * builds its fields once, when it mounts, so a form kept across tables would keep the wrong ones).
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

interface Team extends Record {
  motto: string;
}

class TeamTable extends Table<Team> {
  public name = 'team';
  public columns = withRecordColumns<Team>({
    motto: new StringColumn('motto'),
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
    if (name === 'user') {
      return new UserTable();
    }
    if (name === 'team') {
      return new TeamTable();
    }
    throw new Error(`no such table: ${name}`);
  },
}));

// import AFTER the mock so the page module binds the mocked db seams
import { recordFormPage } from '../src/pages/RecordFormPage';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let phoneMode = false;
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

describe('the record form page keeps its form', () => {
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

  /** One render of the page by its parent — a fresh props object every time, as a container passes. */
  const renderPage = async (table = 'user') => {
    const Page = recordFormPage.component as React.ComponentType<any>;
    await act(async () => {
      root.render(
        <MemoryRouter>
          {/* new-record forms: nothing to load, the form's life across renders is the subject */}
          <Page urlParams={{ table }} />
        </MemoryRouter>
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const fieldLabels = () => Array.from(document.querySelectorAll('label')).map((label) => label.textContent ?? '');

  const emailField = () => {
    const label = Array.from(document.querySelectorAll('label')).find((el) => el.textContent?.includes('Email'));
    const field = label && (document.getElementById(label.getAttribute('for') as string) as HTMLInputElement | null);
    if (!field) {
      throw new Error('the Email field is not on the page');
    }
    return field;
  };

  const type = async (field: HTMLInputElement | HTMLTextAreaElement, text: string) => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setValue = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  for (const face of ['desktop', 'phone'] as const) {
    it(`${face}: what was typed is still in the same field after the page's parent renders again`, async () => {
      phoneMode = face === 'phone';
      await renderPage();
      const field = emailField();
      await type(field, 'someone@example.com');
      expect(emailField().value).toBe('someone@example.com');

      await renderPage();
      await renderPage();

      expect(emailField().value).toBe('someone@example.com');
      expect(emailField()).toBe(field);
    });
  }

  it("a different table is a different form, with that table's fields", async () => {
    phoneMode = false;
    await renderPage('user');
    expect(fieldLabels().some((label) => label.includes('Email'))).toBe(true);

    await renderPage('team');

    expect(fieldLabels().some((label) => label.includes('Motto'))).toBe(true);
    expect(fieldLabels().some((label) => label.includes('Email'))).toBe(false);
  });
});
