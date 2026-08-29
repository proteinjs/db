/**
 * @jest-environment jsdom
 *
 * RecordForm functional gaps (task #53 part 2):
 *  - item 2: Delete routes through the confirmation dialog — the service delete only runs after
 *    the user confirms (the immediate-delete repro), and cancel is a no-op.
 *  - item 3: readonly fields (id/created/updated) are readOnly, not disabled — copyable.
 *  - item 7: field controls tell the truth about column types — booleans render as checkboxes,
 *    dates as native date inputs, reference columns say what they expect ('comma-separated ids').
 *  - save-path truth: the update payload carries real values — a boolean stays a boolean, a
 *    DateColumn becomes a Date — and readonly display strings are never written back into the
 *    record (pre-fix, `created` round-tripped through its display string, which
 *    DateTimeColumn.serialize turns into null on every save).
 */
import React from 'react';
import moment from 'moment';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import {
  BooleanColumn,
  DateColumn,
  DateTimeColumn,
  Record,
  Reference,
  ReferenceArray,
  ReferenceArrayColumn,
  ReferenceColumn,
  StringColumn,
  Table,
  withRecordColumns,
} from '@proteinjs/db';
// Load the package's reflection source graph: RecordForm resolves RecordFormCustomizations
// through SourceRepository, which only knows the type once the generated index has merged it.
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

interface Task extends Record {
  title: string;
  active: boolean | null;
  dueDate: Date;
  archivedAt: moment.Moment | null;
  owner: Reference<any>;
  tags: ReferenceArray<any>;
}

class TaskTable extends Table<Task> {
  public name = 'admin_test_task';
  public columns = withRecordColumns<Task>({
    title: new StringColumn('title'),
    active: new BooleanColumn('active'),
    dueDate: new DateColumn('due_date'),
    archivedAt: new DateTimeColumn('archived_at'),
    owner: new ReferenceColumn('owner', 'user', false),
    // ObjectColumn descendants (incl. ReferenceArrayColumn) are ui.hidden by default; surface it
    tags: new ReferenceArrayColumn('tags', 'tag', false, { ui: { hidden: false } }),
  });
}

const created = moment('2026-01-02T03:04:05.000Z');
const updated = moment('2026-02-03T04:05:06.000Z');
const archivedAt = moment('2026-03-04T05:06:07.000Z');

function loadedRecord(): Task {
  return {
    id: 'task-1',
    title: 'Write tests',
    active: true,
    dueDate: moment('2026-08-10', 'YYYY-MM-DD').toDate(),
    archivedAt,
    owner: new Reference('user', 'user-9'),
    tags: new ReferenceArray('tag', ['tag-1', 'tag-2']),
    created,
    updated,
  } as Task;
}

describe('RecordForm', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
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

  const mount = async (record?: Task) => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RecordForm table={new TaskTable()} record={record} />
        </MemoryRouter>
      );
    });
    // Let Form.onLoad (async componentDidMount work) settle
    await act(async () => {
      await Promise.resolve();
    });
  };

  const findButton = (name: string) => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === name);
    if (!button) {
      throw new Error(`Button not rendered: ${name}`);
    }

    return button;
  };

  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  const inputByLabel = (labelText: string) => {
    const label = Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.startsWith(labelText));
    if (!label) {
      throw new Error(`No field labeled: ${labelText}`);
    }

    const control = label.getAttribute('for')
      ? document.getElementById(label.getAttribute('for')!)
      : label.parentElement?.querySelector('input');
    if (!control) {
      throw new Error(`No input for label: ${labelText}`);
    }

    return control as HTMLInputElement;
  };

  const dialog = () => document.querySelector('[role="dialog"]');

  describe('type-truthful field controls (item 7)', () => {
    it('renders booleans as a checked checkbox, dates as a native date input, and readonly timestamps as copyable text', async () => {
      await mount(loadedRecord());

      const active = inputByLabel('Active');
      expect(active.type).toBe('checkbox');
      expect(active.checked).toBe(true);

      const dueDate = inputByLabel('Due date');
      expect(dueDate.type).toBe('date');
      expect(dueDate.value).toBe('2026-08-10');

      // Readonly fields render as value ROWS (round 2): selectable text with a copy control
      // and no input chrome at all.
      for (const labelText of ['Created', 'Updated', 'Archived at']) {
        const label = Array.from(document.querySelectorAll('label')).find((l) => l.textContent?.startsWith(labelText))!;
        expect(label).toBeDefined();
        // Scope to the field's own shell: two readonly fields can share one two-column row.
        const row = label.parentElement!.parentElement!.querySelector('[data-readonly-value-row]')!;
        expect(row).not.toBeNull();
        expect(row.querySelector(`button[aria-label="Copy ${labelText}"]`)).not.toBeNull();
      }
    });

    it('stops pretending on reference columns: helper text names the expected ids', async () => {
      await mount(loadedRecord());

      expect(document.body.textContent).toContain('user record id');
      expect(document.body.textContent).toContain('Comma-separated tag record ids');
      expect(inputByLabel('Owner').value).toBe('user-9');
      expect(inputByLabel('Tags').value).toBe('tag-1, tag-2');
    });

    it('renders a datetime-local input for editable DateTimeColumns on new records', async () => {
      await mount(undefined);

      expect(inputByLabel('Archived at').type).toBe('datetime-local');
      expect(inputByLabel('Active').type).toBe('checkbox');
      expect(inputByLabel('Active').checked).toBe(false);
    });
  });

  describe('delete confirmation (item 2)', () => {
    it('does not delete on click; the service call runs only after the dialog confirms', async () => {
      await mount(loadedRecord());

      await click(findButton('Delete'));
      expect(mockDbService.delete).not.toHaveBeenCalled();
      expect(dialog()).not.toBeNull();
      expect(dialog()!.textContent).toContain('Delete Admin test task?');

      const confirm = Array.from(dialog()!.querySelectorAll('button')).find((b) => b.textContent === 'Delete')!;
      await click(confirm);

      expect(mockDbService.delete).toHaveBeenCalledTimes(1);
      expect(mockDbService.delete.mock.calls[0][1]).toEqual({ id: 'task-1' });
    });

    it('cancel is a no-op', async () => {
      await mount(loadedRecord());

      await click(findButton('Delete'));
      const cancel = Array.from(dialog()!.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!;
      await click(cancel);

      expect(mockDbService.delete).not.toHaveBeenCalled();
      expect(dialog()).toBeNull();
    });
  });

  describe('save-path truth', () => {
    it('sends real values: booleans stay booleans, dates become Dates, and readonly fields never round-trip through display strings', async () => {
      await mount(loadedRecord());

      await click(findButton('Save'));

      expect(mockDbService.update).toHaveBeenCalledTimes(1);
      const payload = mockDbService.update.mock.calls[0][1];
      expect(payload.active).toBe(true);
      expect(payload.dueDate).toBeInstanceOf(Date);
      expect(moment(payload.dueDate).format('YYYY-MM-DD')).toBe('2026-08-10');
      // Pre-fix, these were the human display strings ('Fri, Jan 2nd 26, ...'); `created` then
      // serialized to null on every save. They must remain the loaded moments.
      expect(moment.isMoment(payload.created)).toBe(true);
      expect(payload.created.valueOf()).toBe(created.valueOf());
      expect(moment.isMoment(payload.archivedAt)).toBe(true);
      expect(payload.archivedAt.valueOf()).toBe(archivedAt.valueOf());
      expect(payload.id).toBe('task-1');
    });

    it('an unchecked checkbox saves boolean false, not a string', async () => {
      await mount(loadedRecord());

      await click(inputByLabel('Active'));
      await click(findButton('Save'));

      const payload = mockDbService.update.mock.calls[0][1];
      expect(payload.active).toBe(false);
    });
  });
});
