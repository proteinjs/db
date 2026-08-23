/**
 * @jest-environment jsdom
 *
 * Custom field components on the record form (`RecordFormCustomization.getFieldRenderer`).
 *
 * A customization can take over a field's slot with its own component. The component OWNS the
 * field: it presents the stored value and routes edits through a service of its own, then calls
 * `reload` so the slot shows the stored truth. Consequences pinned here:
 *  - the component renders in the field's slot instead of the default control, and declaring a
 *    renderer surfaces a column the default form hides (ArrayColumn is ui.hidden by default —
 *    the reason user.roles never appeared on the user form);
 *  - the form's save payload never carries a custom-rendered field (its writes are the
 *    component's, through its service — a form save that echoed the value back would either be
 *    refused as a protected-column write or clobber the service's state);
 *  - `reload` re-reads the record through the db service and re-renders the slot;
 *  - renderers are not consulted on the new-record form: a record that doesn't exist yet has no
 *    stored state to present or service to write through.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { ArrayColumn, Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import '../generated';
import { RecordForm } from '../src/form/RecordForm';
import {
  RecordFormCustomization,
  RecordFormFieldProps,
  RecordFormFieldRenderer,
} from '../src/form/RecordFormCustomization';

interface Doc extends Record {
  title: string;
  labels: string[];
}

class DocTable extends Table<Doc> {
  public name = 'field_renderer_test_doc';
  public columns = withRecordColumns<Doc>({
    title: new StringColumn('title'),
    // ArrayColumn is ui.hidden by default; only the renderer surfaces it
    labels: new ArrayColumn<string>('labels'),
  });
}

/** The stored row the (fake) labels service writes and the db service reads back. */
let stored: Doc;

const mockLabelsService = {
  addLabel: jest.fn(async (docId: string, label: string) => {
    stored = { ...stored, labels: [...stored.labels, label] };
  }),
};

const mockDbService = {
  get: jest.fn(async (table: any, query: any) => stored),
  insert: jest.fn(async (table: any, record: any) => record),
  update: jest.fn(async (table: any, record: any) => record),
  delete: jest.fn(async () => 1),
};

jest.mock('@proteinjs/db', () => ({
  ...jest.requireActual('@proteinjs/db'),
  getDbService: () => mockDbService,
}));

function LabelsField({ record, value, reload, label }: RecordFormFieldProps<Doc, string[]>) {
  return (
    <div data-field-renderer='labels'>
      <span>{label}</span>
      {value.map((item) => (
        <span key={item} data-label-chip>
          {item}
        </span>
      ))}
      <button
        type='button'
        onClick={async () => {
          await mockLabelsService.addLabel(record.id, 'c');
          await reload();
        }}
      >
        Add label
      </button>
    </div>
  );
}

class DocRecordFormCustomization extends RecordFormCustomization {
  public table = new DocTable();

  getFieldRenderer(fieldName: string, record: Doc): RecordFormFieldRenderer<Doc> | undefined {
    return fieldName === 'labels' ? LabelsField : undefined;
  }
}

// Stands in for the SourceRepository registration a real customization gets from reflection-build.
jest.mock('../src/form/RecordFormCustomization', () => ({
  ...jest.requireActual('../src/form/RecordFormCustomization'),
  getRecordFormCustomization: (tableName: string) =>
    tableName === 'field_renderer_test_doc' ? new DocRecordFormCustomization() : undefined,
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('RecordForm custom field renderers', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
    stored = { id: 'doc-1', title: 'Doc', labels: ['a', 'b'] } as Doc;
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

  const mount = async (record?: Doc) => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <RecordForm table={new DocTable()} record={record} />
        </MemoryRouter>
      );
    });
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
    await act(async () => {
      await Promise.resolve();
    });
  };

  const chips = () => Array.from(document.querySelectorAll('[data-label-chip]')).map((chip) => chip.textContent);
  const labelsInput = () => Array.from(document.querySelectorAll('label')).find((l) => l.textContent === 'Labels');

  it('renders the customization component in the field slot, surfacing a column the default form hides', async () => {
    await mount({ ...stored });

    expect(document.querySelector('[data-field-renderer="labels"]')).not.toBeNull();
    expect(chips()).toEqual(['a', 'b']);
    // The default control is replaced, not doubled: no text input for the field
    expect(labelsInput()).toBeUndefined();
    // Default controls still render for the other columns
    expect(Array.from(document.querySelectorAll('label')).some((l) => l.textContent?.startsWith('Title'))).toBe(true);
  });

  it('never carries a custom-rendered field in the save payload', async () => {
    await mount({ ...stored });

    await click(findButton('Save'));

    expect(mockDbService.update).toHaveBeenCalledTimes(1);
    const payload = mockDbService.update.mock.calls[0][1];
    expect(payload.title).toBe('Doc');
    expect('labels' in payload).toBe(false);
  });

  it('reload re-reads the record so the slot shows the stored truth after a service write', async () => {
    await mount({ ...stored });

    await click(findButton('Add label'));

    expect(mockLabelsService.addLabel).toHaveBeenCalledWith('doc-1', 'c');
    expect(mockDbService.get).toHaveBeenCalledTimes(1);
    expect(mockDbService.get.mock.calls[0][1]).toEqual({ id: 'doc-1' });
    expect(chips()).toEqual(['a', 'b', 'c']);
  });

  it('does not consult renderers on the new-record form; hidden columns stay hidden there', async () => {
    await mount(undefined);

    expect(document.querySelector('[data-field-renderer="labels"]')).toBeNull();
    expect(labelsInput()).toBeUndefined();
  });
});
