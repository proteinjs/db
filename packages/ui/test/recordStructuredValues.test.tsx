/**
 * @jest-environment jsdom
 *
 * Structured values the registry types OUTSIDE @proteinjs/db (a driver's JSON column — the shape
 * of @proteinjs/db-spanner-common's JsonColumn, which implements Column directly) on the record
 * surfaces (founder, R7 round 3: "in some of the admin record forms, there will be an object in
 * a column and it will just display [Object]… this is the perfect example of what should display
 * that as content, but leverage the content size scalability features of the ui to not be a
 * problem if it's large"). The presentation follows the VALUE's shape, not the column's class:
 *  1. RecordTable: the cell is the structured content view — one line per key, collapsed to
 *     three with the in-place "Show more (n)" — never `[object Object]`.
 *  2. RecordForm: the field is the mono JSON multiline (pretty-printed), full-width in Content,
 *     and the SAVE payload carries the parsed object (round trip), never the display string.
 *  3. A LARGE nested object rides the form's own size door: past the inline-edit bound the
 *     field is the clamped preview with the Open affordance (the expand dialog), not a textarea
 *     the size of the payload.
 */
import React from 'react';
import moment from 'moment';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { INLINE_EDIT_MAX_CHARS, StaticTableLoader } from '@proteinjs/ui';
import { Column, ColumnOptions, Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import '../generated';
import { RecordTable } from '../src/table/RecordTable';
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

class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).IntersectionObserver = StubIntersectionObserver;

/**
 * A driver's JSON column: implements Column directly (the shape of db-spanner-common's
 * JsonColumn), so neither the ObjectColumn nor the StringColumn branches recognize it.
 */
class DriverJsonColumn<T> implements Column<T, any> {
  constructor(
    public name: string,
    public options?: ColumnOptions
  ) {}
  async serialize(fieldValue: T | null | undefined) {
    return fieldValue ?? null;
  }
  async deserialize(serialized: any) {
    return serialized ?? null;
  }
}

interface Change extends Record {
  modelId: string;
  proposed: object | null;
  sourceUrls: string[] | null;
}

class ChangeTable extends Table<Change> {
  public name = 'admin_test_change';
  public columns = withRecordColumns<Change>({
    modelId: new StringColumn('model_id'),
    proposed: new DriverJsonColumn('proposed'),
    sourceUrls: new DriverJsonColumn('source_urls'),
  });
}

const proposal = {
  id: 'gpt-6',
  name: 'GPT-6',
  provider: 'openai',
  reasoningEfforts: ['auto', 'high'],
  pricing: { standard: { inputUsdPer1M: 1, outputUsdPer1M: 2 } },
  description: 'A frontier model.',
  selectable: true,
};
/** The founder's "if it's large": a proposal carrying sixty cited sources — past the inline-edit bound. */
const largeProposal = {
  ...proposal,
  sources: Array.from({ length: 60 }, (_, i) => ({
    url: `https://vendor.example/docs/models/gpt-6/page-${i}`,
    title: `Documentation page ${i}`,
  })),
};

const record = (over: Partial<Change> = {}): Change =>
  ({
    id: 'change-1',
    modelId: 'gpt-6',
    proposed: proposal,
    sourceUrls: ['https://a.example', 'https://b.example'],
    created: moment('2026-01-02T03:04:05.000Z'),
    updated: moment('2026-02-03T04:05:06.000Z'),
    ...over,
  }) as Change;

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('RecordTable — a structured value on a driver-typed column is content', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const mount = async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <RecordTable<Change>
              table={new ChangeTable()}
              tableLoader={
                new StaticTableLoader([record()], { dataKey: `structured-${Math.random()}`, dataQueryKey: 'all' })
              }
              hideButtons
              columns={['modelId', 'proposed', 'sourceUrls']}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await settle();
  };

  const cellFor = (index: number) => container.querySelectorAll('tbody td')[index] as HTMLElement;
  const entriesIn = (cell: HTMLElement) =>
    Array.from(cell.querySelectorAll('[data-structured-cell-entry]')).map((entry) => entry.textContent);

  it('an object renders one line per key, collapsed to three with "Show more (n)" — never [object Object]', async () => {
    await mount();
    const cell = cellFor(1);
    expect(cell.textContent).not.toContain('[object Object]');
    expect(entriesIn(cell)).toEqual(['idgpt-6', 'nameGPT-6', 'provideropenai']);
    const toggle = cell.querySelector('[data-structured-cell-toggle]') as HTMLButtonElement;
    expect(toggle.textContent).toBe('Show more (4)');

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(entriesIn(cell)).toHaveLength(7);
    expect(entriesIn(cell)[4]).toBe('pricing{ standard }');
  });

  it('an array renders one line per item', async () => {
    await mount();
    expect(entriesIn(cellFor(2))).toEqual(['https://a.example', 'https://b.example']);
  });
});

describe('RecordForm — a structured value on a driver-typed column is a JSON field with the size door', () => {
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

  const mount = async (loaded: Change) => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RecordForm table={new ChangeTable()} record={loaded} />
        </MemoryRouter>
      );
    });
    await settle();
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
    await settle();
  };

  it('presents pretty JSON in the mono multiline field (object and array alike) — never [object Object]', async () => {
    await mount(record());
    expect(document.body.textContent).not.toContain('[object Object]');
    const proposed = controlByLabel('Proposed');
    expect(proposed.tagName).toBe('TEXTAREA');
    expect(proposed.value).toBe(JSON.stringify(proposal, null, 2));
    const sourceUrls = controlByLabel('Source urls');
    expect(sourceUrls.tagName).toBe('TEXTAREA');
    expect(sourceUrls.value).toBe(JSON.stringify(['https://a.example', 'https://b.example'], null, 2));
  });

  it('the save payload carries the parsed object (round trip), never the display string', async () => {
    await mount(record());
    await setValue(controlByLabel('Proposed'), '{\n  "id": "gpt-6.1"\n}');
    await clickButton('Save');

    expect(mockDbService.update).toHaveBeenCalledTimes(1);
    const sent = mockDbService.update.mock.calls[0][1];
    expect(sent.proposed).toEqual({ id: 'gpt-6.1' });
    expect(sent.sourceUrls).toEqual(['https://a.example', 'https://b.example']);
  });

  it('a LARGE nested object rides the field’s size door: the clamped preview with Open, not a payload-sized textarea', async () => {
    const json = JSON.stringify(largeProposal, null, 2);
    expect(json.length).toBeGreaterThan(INLINE_EDIT_MAX_CHARS);
    await mount(record({ proposed: largeProposal }));

    expect(document.body.textContent).not.toContain('[object Object]');
    const preview = document.body.querySelector('[data-field-preview]') as HTMLElement;
    expect(preview).not.toBeNull();
    expect(preview.getAttribute('aria-label')).toBe('Open Proposed');
    expect(document.body.textContent).toContain(`${json.length.toLocaleString()} characters — showing the first lines`);
    const open = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'Open');
    expect(open).toBeDefined();
  });
});
