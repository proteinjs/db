/**
 * @jest-environment jsdom
 *
 * Unbounded ('MAX') plain-text columns on the record surfaces (founder ruling, admin round 3):
 *  1. They SURFACE on the record FORM as multiline fields — the form renders any length
 *     safely now (a migration's failure stack is exactly what the form gets opened to read).
 *  2. Past the inline-edit bound they render the round-2 grammar: a bounded clamped preview
 *     plus the one expand affordance — never a raw inline textarea seat for a huge value.
 *  3. An author's explicit `ui: { hidden: true }` still hides the column everywhere.
 *  4. They stay OUT of the record table's default column pick (a row can't afford one) —
 *     while an Object column an author opted visible remains pickable (its storage is MAX,
 *     but it renders as a bounded mono snippet).
 */
import React from 'react';
import moment from 'moment';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { ObjectColumn, Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import '../generated';
import { RecordForm } from '../src/form/RecordForm';
import { defaultRecordTableColumns } from '../src/table/RecordTable';

const mockDbService: { get: jest.Mock; insert: jest.Mock; update: jest.Mock; delete: jest.Mock } = {
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

interface Incident extends Record {
  title: string;
  report: string;
  transcript: string;
}

class IncidentTable extends Table<Incident> {
  public name = 'admin_test_incident';
  public columns = withRecordColumns<Incident>({
    title: new StringColumn('title'),
    /** The AR-1 case: unbounded plain text, no author ui options at all. */
    report: new StringColumn('report', {}, 'MAX'),
    /** Explicitly hidden by its author — the ruling changes the DEFAULT, not this. */
    transcript: new StringColumn('transcript', { ui: { hidden: true } }, 'MAX'),
  });
}

interface Payloaded extends Record {
  title: string;
  payload: { retries: number } | null;
}

class PayloadedTable extends Table<Payloaded> {
  public name = 'admin_test_payloaded';
  public columns = withRecordColumns<Payloaded>({
    title: new StringColumn('title'),
    payload: new ObjectColumn('payload', { ui: { hidden: false } }),
  });
}

const created = moment('2026-01-02T03:04:05.000Z');
const updated = moment('2026-02-03T04:05:06.000Z');

function loadedIncident(report: string): Incident {
  return {
    id: 'incident-1',
    title: 'Nightly sync halt',
    report,
    transcript: 'never rendered',
    created,
    updated,
  } as Incident;
}

describe('unbounded text on the record form', () => {
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

  const mount = async (record?: Incident) => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RecordForm table={new IncidentTable()} record={record} />
        </MemoryRouter>
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const labelFor = (label: string): HTMLLabelElement | undefined => {
    return Array.from(document.body.querySelectorAll('label')).find((candidate) =>
      candidate.textContent?.startsWith(label)
    );
  };

  it('an unbounded column surfaces as a multiline field (a bounded value edits inline)', async () => {
    await mount(loadedIncident('The sync halted at step 3.'));
    const label = labelFor('Report');
    expect(label).toBeDefined();
    const control = document.getElementById(label!.htmlFor) as HTMLElement;
    expect(control).not.toBeNull();
    expect(control.tagName).toBe('TEXTAREA');
    expect((control as HTMLTextAreaElement).value).toBe('The sync halted at step 3.');
  });

  it('past the inline bound it renders the bounded preview + expand affordance, not an inline editor', async () => {
    const bigReport = 'x'.repeat(2500);
    await mount(loadedIncident(bigReport));

    const label = labelFor('Report');
    expect(label).toBeDefined();
    // No inline editor control — the value is editable only through the expand dialog.
    const controls = Array.from(document.body.querySelectorAll('textarea, input')).filter(
      (control) => (control as HTMLInputElement).value === bigReport
    );
    expect(controls).toHaveLength(0);
    // The clamped preview doorway…
    const preview = document.body.querySelector('[data-field-preview]');
    expect(preview).not.toBeNull();
    expect(preview!.textContent).toContain('x'.repeat(100));
    // …the character count helper…
    expect(document.body.textContent).toContain('2,500 characters — showing the first lines');
    // …and the one expand affordance.
    const openButton = Array.from(document.body.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === 'Open'
    );
    expect(openButton).toBeDefined();
  });

  it("an author's explicit ui.hidden still hides the column from the form", async () => {
    await mount(loadedIncident('short'));
    expect(labelFor('Transcript')).toBeUndefined();
    expect(document.body.textContent).not.toContain('never rendered');
  });
});

describe('unbounded text and the record table default pick', () => {
  it('unbounded plain-text columns never join the default pick (hidden ones stay hidden too)', () => {
    const columns = defaultRecordTableColumns(new IncidentTable());
    expect(columns).toContain('title');
    expect(columns).not.toContain('report');
    expect(columns).not.toContain('transcript');
  });

  it('an Object column an author opted visible remains pickable (MAX storage, bounded snippet)', () => {
    const columns = defaultRecordTableColumns(new PayloadedTable());
    expect(columns).toContain('payload');
  });
});
