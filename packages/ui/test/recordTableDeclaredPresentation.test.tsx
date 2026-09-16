/**
 * @jest-environment jsdom
 *
 * Declared presentation on the generic record surfaces (the migrations
 * ops table): the framework renders what tables declare —
 *  1. `ColumnOptions.ui.label` is the column's header on the record table AND its field label
 *     on the record form (one owner; the migration ledger's `startTime` reads "Ran at" on both);
 *  2. `Table.ui.recordTable.sort` is the record table's default ordering (the migration ledger:
 *     newest first by `created` — a row that never ran keeps its place among the rows that
 *     did); undeclared tables keep `updated` desc;
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
  SortCriteria,
  StringColumn,
  Table,
  withRecordColumns,
} from '@proteinjs/db';

const captured: { sorts: any[][] } = { sorts: [] };
/** The rows the default loader's query finds — served in the order the query asks for. */
let seededRows: any[] = [];

/** A value as the store compares it: an absent value is the least value (GoogleSQL's NULL). */
const sortValue = (value: any): number | string => {
  if (value == null) {
    return Number.NEGATIVE_INFINITY;
  }
  return moment.isMoment(value) ? value.valueOf() : value;
};

/** The store's ORDER BY over in-memory rows: each criterion in turn, ascending or descending. */
const storeOrder = (rows: any[], criteria: SortCriteria<any>[]): any[] =>
  [...rows].sort((a, b) => {
    for (const { field, desc } of criteria) {
      const left = sortValue(a[field]);
      const right = sortValue(b[field]);
      if (left === right) {
        continue;
      }
      const ascending = left < right ? -1 : 1;
      return desc ? -ascending : ascending;
    }
    return 0;
  });

const mockDb = {
  query: jest.fn(async (table: any, qb: QueryBuilder<any>) => {
    const criteria = qb.getSortCriteria();
    captured.sorts.push(criteria);
    return storeOrder(seededRows, criteria);
  }),
  getRowCount: jest.fn(async () => seededRows.length),
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

const runRows: Run[] = [{ id: 'r-1', email: 'a@example.com', startedAt: moment('2026-09-01T10:00:00Z') } as Run];

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

/**
 * A ledger row created on `createdDay`; a row that ran carries its start time (`ranDay`), a row
 * that never ran has none.
 */
const ledgerRow = (letter: string, createdDay: string, status: string, ranDay?: string): Migration =>
  ({
    id: `ledger-id-${letter}`,
    name: `ledger-row-${letter}`,
    description: `ledger row ${letter}`,
    status,
    ...(ranDay ? { startTime: moment(`${ranDay}T10:00:00Z`), endTime: moment(`${ranDay}T10:00:01Z`) } : {}),
    created: moment(`${createdDay}T09:00:00Z`),
    updated: moment(`${ranDay ?? createdDay}T10:00:01Z`),
  }) as unknown as Migration;

describe('RecordTable — declared presentation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    captured.sorts = [];
    seededRows = [];
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
    // The default loader's rows arrive through react-query (a query + a row count in flight).
    for (let i = 0; i < 20 && seededRows.some((row) => !document.body.textContent?.includes(row.name)); i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };

  /** The ledger rows on screen, top to bottom, by the letter of their name. */
  const renderedLetters = () =>
    Array.from(document.querySelectorAll('tbody tr'))
      .map((tr) => tr.textContent?.match(/ledger-row-([A-Z])/)?.[1])
      .filter((letter): letter is string => letter !== undefined);

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

  it('the migration ledger declares its order: created desc (newest first), id breaking ties', async () => {
    await mountTable(new MigrationTable());
    expect(captured.sorts[0]).toEqual([
      { field: 'created', desc: true },
      { field: 'id', desc: true },
    ]);
  });

  it('the migration ledger reads newest first by created — a row that never ran sits among the rows that did, by age', async () => {
    // Two rows ran, days after they were created; two never did (no start time). Newest first
    // by created: D, C, B, A — status plays no part. An order by run time would float B and D
    // above C and A (the never-run rows have no start time, the least value to the store).
    seededRows = [
      ledgerRow('A', '2026-08-01', 'proposed'),
      ledgerRow('B', '2026-08-02', 'success', '2026-08-05'),
      ledgerRow('C', '2026-08-03', 'proposed'),
      ledgerRow('D', '2026-08-04', 'success', '2026-08-06'),
    ];
    await mountTable(new MigrationTable());
    expect(renderedLetters()).toEqual(['D', 'C', 'B', 'A']);
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
