/**
 * @jest-environment jsdom
 *
 * Declared presentation on the generic record surfaces (founder ask 2026-09-02, the Migrations
 * ops table): the framework renders what tables declare —
 *  1. `ColumnOptions.ui.label` is the column's header on the record table AND its field label
 *     on the record form (one owner; the migration ledger's `startTime` reads "Ran at" on both);
 *  2. `Table.ui.recordTable.sort` is the record table's default ordering (the migration ledger:
 *     most recent run first, never-run rows last); undeclared tables keep `updated` desc;
 *  3. the migration ledger's own declaration: name → description → status → Ran at → duration
 *     → end time → output, then the record family's created/updated.
 */
import React from 'react';
import moment from 'moment';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { StaticTableLoader } from '@proteinjs/ui';
import {
  DateTimeColumn,
  Migration,
  MigrationTable,
  QueryBuilder,
  Record,
  StringColumn,
  Table,
  withRecordColumns,
} from '@proteinjs/db';

const captured: { sorts: any[][] } = { sorts: [] };
const mockDb = {
  query: jest.fn(async (table: any, qb: QueryBuilder<any>) => {
    captured.sorts.push(qb.getSortCriteria());
    return [];
  }),
  getRowCount: jest.fn(async () => 0),
};
const mockDbService = { get: jest.fn(), update: jest.fn(async () => 1), delete: jest.fn(async () => 1) };

jest.mock('@proteinjs/db', () => ({
  ...jest.requireActual('@proteinjs/db'),
  getDb: () => mockDb,
  getDbService: () => mockDbService,
}));

// The reflection graph: the form resolves the migration ledger's RecordFormCustomization from it.
import '../generated';
import { RecordTable } from '../src/table/RecordTable';
import { RecordForm } from '../src/form/RecordForm';

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

// The exact UserAuth instance TableAuth consults (per-package installs — resolve THROUGH db):
// a logged-in admin keeps auth-derived button decisions out of this suite's way.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UserAuth } = require(
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require.resolve('@proteinjs/user-auth', { paths: [require('path').dirname(require.resolve('@proteinjs/db'))] })
);

interface Run extends Record {
  email: string;
  startedAt: moment.Moment;
}

/** A column with a declared label and a declared default sort. */
class DeclaringRunTable extends Table<Run> {
  public name = 'declared_run';
  public columns = withRecordColumns<Run>({
    email: new StringColumn('email'),
    startedAt: new DateTimeColumn('started_at', { ui: { label: 'Kicked off' } }),
  });
  public ui: Table<Run>['ui'] = {
    recordTable: { sort: [{ field: 'startedAt', desc: true }] },
  };
}

/** Same schema, nothing declared — the humanized names and the `updated` default stand. */
class UndeclaredRunTable extends Table<Run> {
  public name = 'undeclared_run';
  public columns = withRecordColumns<Run>({
    email: new StringColumn('email'),
    startedAt: new DateTimeColumn('started_at'),
  });
}

const runRows: Run[] = [{ id: 'r-1', email: 'a@n3xa.io', startedAt: moment('2026-09-01T10:00:00Z') } as Run];

const migrationRow = {
  id: 'bee7a15c-369f-4e77-abf7-ccd5dc3ae60c',
  name: 'BackfillOnboardingStateForExistingAccounts',
  description: 'Marks every existing account onboarded',
  status: 'success',
  startTime: moment('2026-08-30T10:00:00Z'),
  endTime: moment('2026-08-30T10:00:02Z'),
  duration: '2 secs',
  output: { rowsInserted: 12 },
  created: moment('2026-08-30T09:00:00Z'),
  updated: moment('2026-08-30T10:00:02Z'),
} as unknown as Migration;

describe('RecordTable — declared presentation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    captured.sorts = [];
    (UserAuth as any).userRepo = { getUser: () => ({ email: 'admin@test.local', roles: ['admin'] }) };
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
  });

  const mountTable = async <T extends Record>(table: Table<T>, rows?: T[]) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <RecordTable
              table={table}
              {...(rows ? { tableLoader: new StaticTableLoader(rows, undefined as any) } : {})}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  const headerTexts = () =>
    Array.from(document.querySelectorAll('th'))
      .map((th) => th.textContent?.trim() ?? '')
      .filter((text) => text.length > 0);

  it('a declared ui.label is the column header; undeclared columns humanize the property name', async () => {
    await mountTable(new DeclaringRunTable(), runRows);
    expect(headerTexts()).toEqual(['Email', 'Kicked off', 'Created', 'Updated']);
  });

  it('the declared sort is the default loader ordering', async () => {
    await mountTable(new DeclaringRunTable());
    expect(captured.sorts[0]).toEqual([{ field: 'startedAt', desc: true }]);
  });

  it('undeclared tables keep the record family default: updated, newest first', async () => {
    await mountTable(new UndeclaredRunTable());
    expect(captured.sorts[0]).toEqual([{ field: 'updated', desc: true }]);
  });

  it('the migration ledger declares: name, description, status, Ran at, duration, end time, output (+ created/updated)', async () => {
    await mountTable(new MigrationTable(), [migrationRow]);
    expect(headerTexts()).toEqual([
      'Name',
      'Description',
      'Status',
      'Ran at',
      'Duration',
      'End time',
      'Output',
      'Created',
      'Updated',
    ]);
    expect(document.body.textContent).toContain('BackfillOnboardingStateForExistingAccounts');
    // The output snippet is on the row (the affordance); the record form carries the full value.
    expect(document.body.textContent).toContain('rowsInserted');
  });

  it('the migration ledger orders by start_time desc (never-run rows last), ledger order breaking ties', async () => {
    await mountTable(new MigrationTable());
    expect(captured.sorts[0]).toEqual([
      { field: 'startTime', desc: true },
      { field: 'created', desc: false },
    ]);
  });
});

describe('RecordForm — declared labels', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const labelTexts = () => Array.from(document.querySelectorAll('label')).map((label) => label.textContent?.trim());

  it('the migration form reads the same declared label (Ran at) and carries the full run + failure fields', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RecordForm table={new MigrationTable()} record={migrationRow} />
        </MemoryRouter>
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const labels = labelTexts();
    expect(labels).toContain('Ran at');
    expect(labels).not.toContain('Start time');
    for (const expected of [
      'Name',
      'Description',
      'Status',
      'Duration',
      'End time',
      'Output',
      'Failure message',
      'Failure stack',
    ]) {
      expect(labels).toContain(expected);
    }
    // The run's output arrives in full (pretty JSON), not the row snippet.
    expect(document.body.textContent).toContain('"rowsInserted": 12');
    // Sections: the identity/flags group leads unlabeled, then Run, then System.
    const sectionLabels = Array.from(document.querySelectorAll('[data-form-section-label]')).map(
      (el) => el.textContent
    );
    expect(sectionLabels).toEqual(['Run', 'System']);
  });
});
