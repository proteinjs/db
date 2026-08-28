/**
 * @jest-environment jsdom
 *
 * RecordForm's long-text and structured-value fields (the admin-surface polish rev).
 * Contracts as OUTCOMES:
 *  1. Long-text columns (maxLength > 255) render as multiline textareas — a single-line
 *     input truncates exactly what the form exists to show.
 *  2. Object columns present pretty-printed JSON in a multiline field and the SAVE payload
 *     carries the parsed OBJECT (round trip), never the display string.
 *  3. Invalid JSON refuses the save with a message naming the field — the service update
 *     never runs.
 *  4. Readonly timestamps display compact ('MMM D, YYYY, h:mm A') with the relative read as
 *     the field's helper line.
 */
import React from 'react';
import moment from 'moment';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { ObjectColumn, Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import '../generated';
import { RecordForm } from '../src/form/RecordForm';

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

interface Job extends Record {
  title: string;
  description: string;
  payload: { retries: number } | null;
}

class JobTable extends Table<Job> {
  public name = 'admin_test_job';
  public columns = withRecordColumns<Job>({
    title: new StringColumn('title'),
    description: new StringColumn('description', {}, 4000),
    payload: new ObjectColumn('payload', { ui: { hidden: false } }),
  });
}

const created = moment('2026-01-02T03:04:05.000Z');
const updated = moment('2026-02-03T04:05:06.000Z');

function loadedRecord(): Job {
  return {
    id: 'job-1',
    title: 'Nightly export',
    description: 'A very long description of what the job does.',
    payload: { retries: 3 },
    created,
    updated,
  } as Job;
}

describe('RecordForm structured fields', () => {
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

  const mount = async (record?: Job) => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RecordForm table={new JobTable()} record={record} />
        </MemoryRouter>
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const controlByLabel = (label: string): HTMLInputElement | HTMLTextAreaElement => {
    const labels = Array.from(document.body.querySelectorAll('label'));
    const match = labels.find((candidate) => candidate.textContent?.startsWith(label));
    if (!match) {
      throw new Error(`no field labeled ${label}`);
    }
    const control = document.getElementById(match.htmlFor) as HTMLInputElement | HTMLTextAreaElement;
    if (!control) {
      throw new Error(`no control for label ${label}`);
    }
    return control;
  };

  const setValue = async (control: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    await act(async () => {
      setter.call(control, value);
      control.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const clickButton = async (name: string) => {
    const button = Array.from(document.body.querySelectorAll('button')).find(
      (candidate) => candidate.textContent === name
    )!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it('long-text columns render as multiline textareas; short ones stay single-line inputs', async () => {
    await mount(loadedRecord());
    expect(controlByLabel('Title').tagName).toBe('INPUT');
    expect(controlByLabel('Description').tagName).toBe('TEXTAREA');
  });

  it('object columns present pretty JSON and save the parsed object (round trip)', async () => {
    await mount(loadedRecord());
    const payloadControl = controlByLabel('Payload');
    expect(payloadControl.tagName).toBe('TEXTAREA');
    expect(payloadControl.value).toBe(JSON.stringify({ retries: 3 }, null, 2));

    await setValue(payloadControl, '{\n  "retries": 5\n}');
    await clickButton('Save');

    expect(mockDbService.update).toHaveBeenCalledTimes(1);
    const payloadSent = mockDbService.update.mock.calls[0][1].payload;
    expect(payloadSent).toEqual({ retries: 5 });
  });

  it('invalid JSON refuses the save with a message naming the field; the update never runs', async () => {
    await mount(loadedRecord());
    await setValue(controlByLabel('Payload'), '{not json');
    await clickButton('Save');

    expect(mockDbService.update).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Payload must be valid JSON');
  });

  it('readonly timestamps display compact with the relative read as the helper line', async () => {
    await mount(loadedRecord());
    const createdControl = controlByLabel('Created') as HTMLInputElement;
    expect(createdControl.value).toBe(created.format('MMM D, YYYY, h:mm A'));
    expect(document.body.textContent).toContain(created.fromNow());
  });
});
