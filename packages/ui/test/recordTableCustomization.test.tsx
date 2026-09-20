/**
 * @jest-environment jsdom
 *
 * The record-table customization seam (`RecordTableCustomization` — the table twin of the record
 * form's): a Loadable names its table and says which chips a page of rows wears. The contract this
 * suite pins, on the REAL `RecordTable`:
 *  - the chips are asked for ONCE PER LOADED PAGE, with every row of the page — never per row;
 *  - a named row wears its chip after its identity (the first column) on the desktop face and on
 *    the phone face, with the customization's icon;
 *  - the chips arrive WITH the rows: no commit shows a row of the page before its chip;
 *  - a row the customization did not name, and every row of a table with no customization, render
 *    exactly as they always have;
 *  - a page whose chips cannot be read is a failed load — its rows never render as chip-less.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { RowWindow, StaticTableLoader, TableLoader } from '@proteinjs/ui';
import { Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import { RecordTable } from '../src/table/RecordTable';
import {
  RecordTableCustomization,
  RecordTableRowChip,
  RecordTableRowChips,
} from '../src/table/RecordTableCustomization';

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

interface Member extends Record {
  name: string;
  email: string;
}

class MemberTable extends Table<Member> {
  public name = 'member';
  public columns = withRecordColumns<Member>({
    name: new StringColumn('name'),
    email: new StringColumn('email'),
  });
}

/** The same shape under another name, with no customization — the control. */
class GuestTable extends Table<Member> {
  public name = 'guest';
  public columns = withRecordColumns<Member>({
    name: new StringColumn('name'),
    email: new StringColumn('email'),
  });
}

const rows: Member[] = [
  { id: 'm-1', name: 'Ada Park', email: 'ada@example.com' } as Member,
  { id: 'm-2', name: 'Bo Reyes', email: 'bo@example.com' } as Member,
  { id: 'm-3', name: 'Cy Moss', email: 'cy@example.com' } as Member,
];

/** The consumer's customization: one row is paused; the answer comes from one batched lookup. */
class MemberTableCustomization extends RecordTableCustomization {
  table = new MemberTable();
  calls: string[][] = [];
  fail = false;
  /** Holds the answer back so a suite can look at what is on screen while the chips are in flight. */
  gate: Promise<void> | undefined;

  async getRowChips(pageRows: Record[]): Promise<RecordTableRowChips> {
    this.calls.push(pageRows.map((row) => row.id));
    if (this.gate) {
      await this.gate;
    }
    if (this.fail) {
      throw new Error('the lookup is down');
    }
    return { 'm-2': [{ label: 'Paused', kind: 'paused' }] };
  }

  getChipIcon(chip: RecordTableRowChip) {
    return chip.kind === 'paused' ? <svg data-paused-icon='' viewBox='0 0 24 24' /> : undefined;
  }
}

/** Counts the pages the table actually loaded. */
class CountingLoader implements TableLoader<Member> {
  loads = 0;
  private inner = new StaticTableLoader(rows, undefined as any);
  reactQueryKeys = this.inner.reactQueryKeys;
  async load(startIndex: number, endIndex: number): Promise<RowWindow<Member>> {
    this.loads += 1;
    return this.inner.load(startIndex, endIndex);
  }
}

// Stands in for the SourceRepository registration a real customization gets from reflection-build.
let mockSeated: RecordTableCustomization | undefined;
jest.mock('../src/table/RecordTableCustomization', () => ({
  ...jest.requireActual('../src/table/RecordTableCustomization'),
  getRecordTableCustomization: (tableName: string) =>
    mockSeated && mockSeated.table.name === tableName ? mockSeated : undefined,
}));
const seat = (customization?: RecordTableCustomization) => {
  mockSeated = customization;
};

describe('RecordTable — the table customization seam (row chips)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let customization: MemberTableCustomization;

  beforeEach(() => {
    phoneMode = false;
    customization = new MemberTableCustomization();
    seat(customization);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    seat(undefined);
  });

  const settle = async (until: () => boolean) => {
    for (let i = 0; i < 10 && !until(); i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  const mount = async (table: Table<Member>, loader: TableLoader<Member>, until?: () => boolean) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/record/table?name=' + table.name]}>
            <RecordTable table={table} tableLoader={loader} columns={['name', 'email']} hideButtons />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    await settle(until ?? (() => !!document.body.textContent?.includes('Cy Moss')));
  };

  /** The identity cell (desktop) of the row whose name is given. */
  const identityCell = (name: string): HTMLElement => {
    const cell = Array.from(document.querySelectorAll('tbody td')).find((td) => td.textContent?.startsWith(name));
    if (!cell) {
      throw new Error(`no identity cell for ${name}`);
    }
    return cell as HTMLElement;
  };

  it('asks for the chips ONCE for the whole page, and the named row wears its chip after its name', async () => {
    const loader = new CountingLoader();
    await mount(new MemberTable(), loader);

    expect({ loads: loader.loads, calls: customization.calls }).toEqual({
      loads: 1,
      calls: [['m-1', 'm-2', 'm-3']],
    });
    const chips = Array.from(document.querySelectorAll('[data-record-table-row-chip]'));
    expect(chips.map((chip) => [chip.getAttribute('data-record-table-row-chip'), chip.textContent])).toEqual([
      ['paused', 'Paused'],
    ]);
    const cell = identityCell('Bo Reyes');
    expect(cell.textContent).toBe('Bo ReyesPaused');
    expect(cell.querySelector('[data-record-table-row-chip] [data-paused-icon]')).not.toBeNull();
  });

  it('a row with no chip, and a table with no customization, render exactly as they always have', async () => {
    await mount(new MemberTable(), new CountingLoader());
    const unnamedRow = identityCell('Ada Park').outerHTML;
    act(() => root.unmount());
    root = createRoot(container);

    await mount(new GuestTable(), new CountingLoader());
    expect(identityCell('Ada Park').outerHTML).toBe(unnamedRow);
    expect(document.querySelector('[data-record-table-row-chip]')).toBeNull();
    // The guest table loaded its page without the member customization ever being asked again.
    expect(customization.calls).toHaveLength(1);
  });

  it('the chips arrive WITH the rows: while the lookup is in flight no row of the page is on screen', async () => {
    let open: () => void = () => undefined;
    customization.gate = new Promise<void>((resolve) => (open = resolve));
    await mount(new MemberTable(), new CountingLoader(), () => customization.calls.length === 1);
    expect(customization.calls).toHaveLength(1);
    expect(document.body.textContent).not.toContain('Bo Reyes');

    await act(async () => open());
    await settle(() => !!document.querySelector('[data-record-table-row-chip]'));
    expect(identityCell('Bo Reyes').textContent).toBe('Bo ReyesPaused');
  });

  it('the phone face: the chip follows the card’s identity line', async () => {
    phoneMode = true;
    await mount(new MemberTable(), new CountingLoader());
    const face = document.querySelector('[data-table-phone-face]');
    expect(face).not.toBeNull();
    const chip = face!.querySelector('[data-record-table-row-chip="paused"]');
    expect(chip?.parentElement?.textContent).toBe('Bo ReyesPaused');
    expect(face!.querySelectorAll('[data-record-table-row-chip]')).toHaveLength(1);
    expect(customization.calls).toEqual([['m-1', 'm-2', 'm-3']]);
  });

  it('a page whose chips cannot be read is a failed load — its rows never render as chip-less', async () => {
    customization.fail = true;
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await mount(new MemberTable(), new CountingLoader(), () => customization.calls.length === 1);
      await settle(() => false);
      expect(document.body.textContent).not.toContain('Bo Reyes');
    } finally {
      logged.mockRestore();
    }
  });
});
