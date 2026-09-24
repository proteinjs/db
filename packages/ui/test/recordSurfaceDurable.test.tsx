/**
 * @jest-environment jsdom
 *
 * A DURABLE table (`Table.durable`) on the generic record surfaces: its rows are never deleted by
 * a caller, so neither surface offers the act — the record table's seat carries no delete act
 * (derived or declared) and no row selection that would serve one; the record form no Delete. The
 * acts are absent, not greyed. A table with the same doors that does not declare it keeps both.
 *
 * The founder's report (2026-09-24): "you can select migrations and delete them in prod from the
 * record table; they're supposed to be durable records".
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { StaticTableLoader } from '@proteinjs/ui';
import { MigrationTable, Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
// Load the package's reflection source graph: RecordForm resolves RecordFormCustomizations
// through SourceRepository, which only knows the type once the generated index has merged it.
import '../generated';
import { RecordTable } from '../src/table/RecordTable';
import { RecordForm } from '../src/form/RecordForm';

const mockDbService = {
  get: jest.fn(),
  insert: jest.fn(async (table: any, record: any) => record),
  update: jest.fn(async (table: any, record: any) => record),
  delete: jest.fn(async () => 1),
};

jest.mock('@proteinjs/db', () => ({
  ...jest.requireActual('@proteinjs/db'),
  getDbService: () => mockDbService,
}));

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

// The exact UserAuth instance TableAuth consults (per-package installs — resolve THROUGH db).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UserAuth } = require(
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require.resolve('@proteinjs/user-auth', { paths: [require('path').dirname(require.resolve('@proteinjs/db'))] })
);

const setUser = (roles: string[]) => {
  (UserAuth as any).userRepo = { getUser: () => ({ email: 'user@test.local', roles }) };
};
const setMapping = (mapping: { [permission: string]: string[] }) => {
  (UserAuth as any).permissionRolesMapping = { getRoles: (permission: string) => mapping[permission] };
};

interface Entry extends Record {
  title: string;
}

/** Query, update and delete doors open to 'ledger' — no insert door (the migration ledger's shape). */
class DeletableLedgerTable extends Table<Entry> {
  public name = 'deletable_ledger';
  public auth: Table<Entry>['auth'] = {
    db: { query: { permission: 'ledger' }, update: { permission: 'ledger' }, delete: { permission: 'ledger' } },
    service: { query: { permission: 'ledger' }, update: { permission: 'ledger' }, delete: { permission: 'ledger' } },
  };
  public columns = withRecordColumns<Entry>({
    title: new StringColumn('title'),
  });
}

/** The same doors, declared durable. */
class DurableLedgerTable extends DeletableLedgerTable {
  public name = 'durable_ledger';
  public durable = true;
}

/** Every door open (a create act draws), a declared delete act with its own door — and durable. */
class DurableDeclaredDeleteTable extends Table<Entry> {
  public name = 'durable_declared_delete';
  public durable = true;
  public auth: Table<Entry>['auth'] = {
    db: { all: { permission: 'ledger' } },
    service: { all: { permission: 'ledger' } },
  };
  public ui: Table<Entry>['ui'] = {
    recordTable: { actions: [{ kind: 'delete', label: 'Remove selected entries', door: { permission: 'ledger' } }] },
  };
  public columns = withRecordColumns<Entry>({
    title: new StringColumn('title'),
  });
}

const rows: Entry[] = [{ id: 'e-1', title: 'first entry' } as Entry];

describe('a durable table on the record surfaces', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    setMapping({ ledger: ['ledger-keeper'], dev: ['ledger-keeper'] });
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
    (UserAuth as any).permissionRolesMapping = undefined;
  });

  const mountTable = async (table: Table<any>, tableRows: any[] = rows, shownText = 'first entry') => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <RecordTable table={table} tableLoader={new StaticTableLoader(tableRows, undefined as any)} />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    for (let i = 0; i < 5 && !document.body.textContent?.includes(shownText); i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(document.body.textContent).toContain(shownText);
  };

  const mountForm = async (table: Table<any>, record: any) => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RecordForm table={table} record={record} />
        </MemoryRouter>
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
  };

  const selectRowCheckbox = () => document.querySelector('input[aria-label="Select row"]') as HTMLInputElement | null;
  const deleteAct = () => document.querySelector('button[aria-label="Delete selected rows"]');
  const buttonNamed = (name: string) =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent === name);

  describe('the record table', () => {
    it('draws no delete act and no row selection — for break-glass admin as for the doors’ own holder', async () => {
      for (const roles of [['ledger-keeper'], ['admin']]) {
        setUser(roles);
        await mountTable(new DurableLedgerTable());

        expect(selectRowCheckbox()).toBeNull();
        expect(document.querySelector('input[aria-label="Select all"]')).toBeNull();
        expect(deleteAct()).toBeNull();

        await act(async () => {
          root.unmount();
        });
        root = createRoot(container);
      }
    });

    it('a declared delete act does not reopen it: selecting a row surfaces no delete act under either name', async () => {
      setUser(['ledger-keeper']);
      await mountTable(new DurableDeclaredDeleteTable());

      // The create act still draws (the insert doors are open) — the seat is there.
      expect(document.querySelector('button[aria-label^="Create"]')).not.toBeNull();
      const checkbox = selectRowCheckbox();
      if (checkbox) {
        await act(async () => {
          checkbox.click();
        });
      }
      expect(document.querySelector('button[aria-label="Remove selected entries"]')).toBeNull();
      expect(deleteAct()).toBeNull();
    });

    it('a table with the same doors that does not declare it keeps selection and its delete act', async () => {
      setUser(['ledger-keeper']);
      await mountTable(new DeletableLedgerTable());

      expect(selectRowCheckbox()).not.toBeNull();
      await act(async () => {
        selectRowCheckbox()!.click();
      });
      expect(deleteAct()).not.toBeNull();
    });

    it('the migration ledger: no selection, no delete act, even for admin', async () => {
      setUser(['admin']);
      await mountTable(
        new MigrationTable(),
        [{ id: 'm-1', name: 'BackfillSomething', description: 'Backfills something', status: 'success' }],
        'BackfillSomething'
      );

      expect(selectRowCheckbox()).toBeNull();
      expect(deleteAct()).toBeNull();
    });
  });

  describe('the record form', () => {
    it('carries no Delete; Save stays', async () => {
      setUser(['admin']);
      await mountForm(new DurableLedgerTable(), { id: 'e-1', title: 'first entry' });

      expect(buttonNamed('Save')).toBeDefined();
      expect(buttonNamed('Delete')).toBeUndefined();
    });

    it('a table that does not declare it keeps its Delete', async () => {
      setUser(['admin']);
      await mountForm(new DeletableLedgerTable(), { id: 'e-1', title: 'first entry' });

      expect(buttonNamed('Delete')).toBeDefined();
    });

    it('the migration ledger’s form: Run and Save, no Delete', async () => {
      setUser(['admin']);
      await mountForm(new MigrationTable(), {
        id: 'm-1',
        name: 'BackfillSomething',
        description: 'Backfills something',
        status: 'success',
        output: { rows: 3 },
      });

      expect(buttonNamed('Run')).toBeDefined();
      expect(buttonNamed('Delete')).toBeUndefined();
    });
  });
});
