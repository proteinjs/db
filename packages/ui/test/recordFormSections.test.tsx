/**
 * @jest-environment jsdom
 *
 * RecordForm's field GROUPING (round 2). Contracts as OUTCOMES:
 *  1. Sections derive from column type + name in a fixed order: identity (name/email/title)
 *     → Content (long text, structured values) → Details (everything else) → System
 *     (id/created/updated), and System is always last.
 *  2. A column's `ui.formGroup` hint overrides the derivation; an unknown hint value becomes
 *     its own titled section, ordered after Details.
 *  3. The record's id renders in System as a readonly value row — a record form's address is
 *     what an admin copies, and the table layer's `ui.hidden` (a DATA-column flag) doesn't
 *     bury it here.
 *  4. A single-section form stays unlabeled — one group needs no header.
 */
import React from 'react';
import moment from 'moment';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { BooleanColumn, ObjectColumn, Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import '../generated';
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

interface Job extends Record {
  name: string;
  failureMessage: string;
  payload: { retries: number } | null;
  status: string;
  manual: boolean;
}

class JobTable extends Table<Job> {
  public name = 'admin_section_job';
  public columns = withRecordColumns<Job>({
    // Declared deliberately out of section order: the form must GROUP, not echo the schema.
    status: new StringColumn('status'),
    failureMessage: new StringColumn('failure_message', {}, 4000),
    name: new StringColumn('name'),
    manual: new BooleanColumn('manual'),
    payload: new ObjectColumn('payload', { ui: { hidden: false } }),
  });
}

/** Same shape, but the status column claims the Content section by hint. */
class HintedJobTable extends Table<Job> {
  public name = 'admin_section_hinted_job';
  public columns = withRecordColumns<Job>({
    status: new StringColumn('status', { ui: { formGroup: 'content' } }),
    failureMessage: new StringColumn('failure_message', {}, 4000),
    name: new StringColumn('name'),
    manual: new BooleanColumn('manual', { ui: { formGroup: 'operations' } }),
    payload: new ObjectColumn('payload', { ui: { hidden: false } }),
  });
}

const created = moment('2026-01-02T03:04:05.000Z');
const updated = moment('2026-02-03T04:05:06.000Z');

function loadedRecord(): Job {
  return {
    id: 'job-77',
    name: 'Nightly export',
    failureMessage: 'It broke',
    payload: { retries: 3 },
    status: 'failure',
    manual: false,
    created,
    updated,
  } as Job;
}

describe('RecordForm sections', () => {
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

  const mount = async (table: Table<Job>, record?: Job) => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RecordForm table={table} record={record} />
        </MemoryRouter>
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const sectionLabels = () =>
    Array.from(document.querySelectorAll('[data-form-section-label]')).map((el) => el.textContent);

  /** The section element a field's label sits inside. */
  const sectionOf = (labelText: string) => {
    const label = Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.startsWith(labelText));
    if (!label) {
      throw new Error(`No field labeled: ${labelText}`);
    }

    return label.closest('[data-form-section]')!;
  };

  const sectionIndex = (labelText: string) =>
    Array.from(document.querySelectorAll('[data-form-section]')).indexOf(sectionOf(labelText) as HTMLElement);

  it('groups fields into identity → Content → Details → System, in that order', async () => {
    await mount(new JobTable(), loadedRecord());

    expect(sectionLabels()).toEqual(['Content', 'Details', 'System']);

    // Identity leads (unlabeled), long text/structured land in Content, the rest in Details,
    // server-managed meta last — regardless of the schema's declaration order.
    expect(sectionIndex('Name')).toBe(0);
    expect(sectionOf('Failure message').textContent).toContain('Content');
    expect(sectionOf('Payload').textContent).toContain('Content');
    expect(sectionOf('Status').textContent).toContain('Details');
    expect(sectionOf('Manual').textContent).toContain('Details');
    expect(sectionOf('Created').textContent).toContain('System');
    expect(sectionOf('Updated').textContent).toContain('System');

    // System is last.
    const sections = document.querySelectorAll('[data-form-section]');
    expect(sectionIndex('Created')).toBe(sections.length - 1);
  });

  it('renders the record id in System as a readonly value row', async () => {
    await mount(new JobTable(), loadedRecord());

    const idSection = sectionOf('Id');
    expect(idSection.textContent).toContain('System');
    const row = idSection.querySelector('[data-readonly-value-row]')!;
    expect(row).not.toBeNull();
    expect(idSection.textContent).toContain('job-77');
  });

  it('ui.formGroup overrides the derivation; an unknown hint becomes its own section after Details', async () => {
    await mount(new HintedJobTable(), loadedRecord());

    // 'status' (a short string that would derive to Details) claims Content by hint.
    expect(sectionOf('Status').textContent).toContain('Content');
    // 'manual' claims a section of its own, humanized, ordered after Details — and with both
    // would-be Details fields re-hinted, Details doesn't render at all (no empty headers).
    expect(sectionLabels()).toEqual(['Content', 'Operations', 'System']);
    expect(sectionOf('Manual').textContent).toContain('Operations');
  });

  it('a new-record form (no System meta) stays a single unlabeled section when one group covers it', async () => {
    class SimpleTable extends Table<{ name: string } & Record> {
      public name = 'admin_section_simple';
      public columns = withRecordColumns<{ name: string } & Record>({
        name: new StringColumn('name'),
      });
    }

    await mount(new SimpleTable() as any, undefined);

    expect(document.querySelectorAll('[data-form-section]').length).toBe(1);
    expect(sectionLabels()).toEqual([]);
  });
});
