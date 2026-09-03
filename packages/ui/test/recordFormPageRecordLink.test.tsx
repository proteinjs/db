/**
 * @jest-environment jsdom
 *
 * The generic record form page against the record-link seam (`Table.ui.recordTable.recordLink`):
 * a stale `/record/form?table=<name>&record=<id>` URL — a bookmark, a link in an old chat, the
 * browser's own history — must not paint the generic form for a table whose rows have their own
 * page. It replace-navigates to the declared link, built from the id ALONE so the redirect never
 * needs a row load (the load effect must not fire), and a stale "new record" URL (no `record`
 * param) lands on the record table instead.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Account extends Record {
  email: string;
}

class OwnPageTable extends Table<Account> {
  public name = 'account';
  public ui: Table<Account>['ui'] = {
    recordTable: {
      recordLink: (row) => `/account/${row.id}?section=admin`,
    },
  };
  public columns = withRecordColumns<Account>({
    email: new StringColumn('email'),
  });
}

const ownPageTable = new OwnPageTable();

/** The record read the redirect must never perform. */
const mockDbService = { get: jest.fn(), update: jest.fn(async () => 1), delete: jest.fn(async () => 1) };

jest.mock('@proteinjs/db', () => ({
  ...jest.requireActual('@proteinjs/db'),
  getDbService: () => mockDbService,
  // The page resolves its table by name off the source graph; these tests don't load it.
  tableByName: (name: string) => {
    if (name === 'account') {
      return ownPageTable;
    }

    throw new Error(`Unable to find table: ${name}`);
  },
}));

/** The navigate calls the page makes, captured while still driving the real router. */
const navigateCalls: any[][] = [];
jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => {
      const navigate = actual.useNavigate();
      return (...args: any[]) => {
        navigateCalls.push(args);
        return navigate(...args);
      };
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MemoryRouter, useLocation } = require('react-router-dom');
// The reflection graph: the page resolves its declared record panels from it.
import '../generated';
import { recordFormPage } from '../src/pages/RecordFormPage';

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

const LocationProbe = () => {
  const location = useLocation();
  return <div data-location={`${location.pathname}${location.search}`} />;
};

const currentLocation = () => document.querySelector('[data-location]')?.getAttribute('data-location');

describe('record form page — the record-link seam', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    navigateCalls.length = 0;
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

  const mount = async (urlParams: { [name: string]: string }) => {
    const Form = recordFormPage.component;
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/record/form']}>
          <LocationProbe />
          <Form urlParams={urlParams} />
        </MemoryRouter>
      );
    });
    for (let i = 0; i < 5 && currentLocation() === '/record/form'; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  it('a stale record URL replace-navigates to the declared link and never loads the row', async () => {
    await mount({ table: 'account', record: 'abc' });

    expect(currentLocation()).toBe('/account/abc?section=admin');
    expect(navigateCalls).toContainEqual(['/account/abc?section=admin', { replace: true }]);
    // Built from the id alone: no record read, so the redirect can't stall or fail on a load.
    expect(mockDbService.get).not.toHaveBeenCalled();
  });

  it('the redirecting page renders no form', async () => {
    await mount({ table: 'account', record: 'abc' });

    expect(container.textContent).toBe('');
  });

  it('a stale new-record URL replace-navigates to the record table', async () => {
    await mount({ table: 'account' });

    expect(currentLocation()).toBe('/record/table?name=account');
    expect(navigateCalls).toContainEqual(['/record/table?name=account', { replace: true }]);
    expect(mockDbService.get).not.toHaveBeenCalled();
  });
});
