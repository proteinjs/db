/**
 * @jest-environment jsdom
 *
 * Declared record-form panels (`RecordPanel`, plans/USAGE_SURFACES.md §B.1) — the seam a
 * package uses to put a related presentation beside a table's record form ("look at a user
 * record and see their usage"). Outcomes pinned:
 *  - resolution: EVERY declared panel for the table, in declared order (then by name), none
 *    for another table — many per table, unlike the one-per-table customization;
 *  - the identity gate: a `{ permission }` panel hides from a non-holder and shows to a holder
 *    and to admin; an undeclared gate falls to the table's `auth.ui.recordForm`, else admin;
 *  - one loader, one paint: the page does not paint until every panel's `load()` resolves
 *    (a deferred load holds the WHOLE page, never a form beside a spinner);
 *  - `reload` re-reads the record AND re-runs `load()`;
 *  - the form with zero panels renders byte-equal to the panel-less page;
 *  - placement is derived: a column beside the form from `lg`, stacked below it narrower, and
 *    below the full-bleed form on phones.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { FormPage } from '@proteinjs/ui';
import { Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import '../generated';

interface User extends Record {
  email: string;
}

class UserTable extends Table<User> {
  public name = 'user';
  public columns = withRecordColumns<User>({
    email: new StringColumn('email'),
  });
}

/** A table whose record form declares its own viewer identity (the panel default). */
class NoteTable extends Table<User> {
  public name = 'note';
  public auth: Table<User>['auth'] = { ui: { recordForm: 'authenticated' } };
  public columns = withRecordColumns<User>({
    email: new StringColumn('email'),
  });
}

const stored: User = { id: 'u-1', email: 'ada@test.local' } as User;

const mockDbService = {
  get: jest.fn(async () => ({ ...stored })),
  insert: jest.fn(async (table: any, record: any) => record),
  update: jest.fn(async (table: any, record: any) => record),
  delete: jest.fn(async () => 1),
};

jest.mock('@proteinjs/db', () => ({
  ...jest.requireActual('@proteinjs/db'),
  getDbService: () => mockDbService,
  tableByName: (name: string) => {
    if (name === 'user') {
      return new UserTable();
    }
    if (name === 'note') {
      return new NoteTable();
    }
    throw new Error(`no such table: ${name}`);
  },
}));

/** The panels "declared" for this suite — stands in for the reflection graph's registration. */
let declared: any[] = [];

jest.mock('../src/panel/RecordPanel', () => {
  const actual = jest.requireActual('../src/panel/RecordPanel');
  return {
    ...actual,
    getRecordPanels: (tableName: string) => actual.getRecordPanels(tableName, declared),
  };
});

// import AFTER the mocks so the page module binds the mocked seams
import { recordFormPage } from '../src/pages/RecordFormPage';
import { RecordForm } from '../src/form/RecordForm';
import { getRecordPanels, RecordPanel, RecordPanelProps } from '../src/panel/RecordPanel';

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

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

/** Emotion under jest injects rules via CSSOM; read the actual styles the classes apply. */
const cssFor = (el: Element): string => {
  const classes = Array.from(el.classList).filter((cls) => cls.startsWith('css-'));
  const out: string[] = [];
  Array.from(document.querySelectorAll('style')).forEach((styleEl) => {
    const rules = styleEl.sheet?.cssRules ?? ([] as unknown as CSSRuleList);
    Array.from(rules).forEach((rule) => {
      if (classes.some((cls) => rule.cssText.includes(`.${cls}`))) {
        out.push(rule.cssText);
      }
    });
  });
  return out.join('\n');
};

const PanelBody = ({ data, reload }: RecordPanelProps<User, { label: string }>) => (
  <div data-panel-body>
    <span data-panel-label>{data.label}</span>
    <button data-panel-reload onClick={() => reload()}>
      reload
    </button>
  </div>
);

class UsagePanel extends RecordPanel<User, { label: string }> {
  table = new UserTable();
  name = 'usage';
  title = 'Usage';
  auth = { permission: 'usage' };
  order = 100;
  loads = 0;
  load = async (record: User) => {
    this.loads += 1;
    return { label: `usage of ${record.email} #${this.loads}` };
  };
  component = PanelBody;
}

class ThoughtsPanel extends UsagePanel {
  name = 'thoughts';
  title = 'Thoughts';
  auth = { permission: 'usage' };
  order = 200;
}

class UndeclaredGatePanel extends UsagePanel {
  name = 'undeclared';
  title = 'Undeclared';
  auth = undefined as any;
}

class NotePanel extends UsagePanel {
  table = new NoteTable() as any;
  name = 'note-panel';
  title = 'Note';
  auth = undefined as any;
}

class InvitePanel extends UsagePanel {
  table = { name: 'invite' } as any;
  name = 'invite';
  title = 'Invite';
}

describe('getRecordPanels — resolution and the identity gate', () => {
  beforeEach(() => {
    setMapping({ usage: ['usage'] });
  });

  afterEach(() => {
    (UserAuth as any).userRepo = undefined;
    (UserAuth as any).permissionRolesMapping = undefined;
  });

  afterEach(() => {
    declared = [];
  });

  it('resolves every panel declared for the table in declared order, and none for another table', () => {
    setUser(['admin']);
    declared = [new ThoughtsPanel(), new InvitePanel(), new UsagePanel()];
    expect(getRecordPanels('user').map((panel) => panel.name)).toEqual(['usage', 'thoughts']);
    expect(getRecordPanels('session')).toEqual([]);
  });

  it('hides a { permission } panel from a non-holder and shows it to a holder and to admin', () => {
    declared = [new UsagePanel()];
    setUser(['users']);
    expect(getRecordPanels('user')).toEqual([]);
    setUser(['usage']);
    expect(getRecordPanels('user').map((panel) => panel.name)).toEqual(['usage']);
    setUser(['admin']);
    expect(getRecordPanels('user').map((panel) => panel.name)).toEqual(['usage']);
  });

  it("an undeclared gate falls to the table's auth.ui.recordForm, else admin-only", () => {
    declared = [new UndeclaredGatePanel(), new NotePanel()];
    setUser(['usage', 'users']);
    expect(getRecordPanels('user')).toEqual([]);
    expect(getRecordPanels('note').map((panel) => panel.name)).toEqual(['note-panel']);
    setUser(['admin']);
    expect(getRecordPanels('user').map((panel) => panel.name)).toEqual(['undeclared']);
  });
});

describe('RecordFormPage with declared panels', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setMapping({ usage: ['usage'] });
    setUser(['admin']);
    mockDbService.get.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    declared = [];
    (UserAuth as any).userRepo = undefined;
    (UserAuth as any).permissionRolesMapping = undefined;
  });

  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const mountPage = async (table = 'user') => {
    const Page = recordFormPage.component as React.ComponentType<any>;
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Page urlParams={{ table, record: 'u-1' }} />
        </MemoryRouter>
      );
    });
    await settle();
  };

  /** MUI's useId counters differ between mounts; the DOM is otherwise deterministic. */
  const normalizeIds = (html: string) => html.replace(/:r[0-9a-z]+:/g, ':id:');

  it('does not paint until every panel load() resolves, then paints form and panel together', async () => {
    let resolveLoad!: (value: { label: string }) => void;
    const panel = new UsagePanel();
    panel.load = () => new Promise((resolve) => (resolveLoad = resolve));
    declared = [panel];
    await mountPage();
    // the record has resolved, the panel has not: nothing on the page — no lone form card
    expect(mockDbService.get).toHaveBeenCalledTimes(1);
    expect(container.innerHTML).toBe('');
    await act(async () => {
      resolveLoad({ label: 'usage of ada' });
    });
    await settle();
    expect(container.querySelector('[data-record-surface]')).toBeTruthy();
    expect(container.textContent).toContain('Email');
    expect(container.querySelector('[data-record-panel="usage"] [data-panel-label]')?.textContent).toBe('usage of ada');
  });

  it('reload re-reads the record AND re-runs load()', async () => {
    const panel = new UsagePanel();
    declared = [panel];
    await mountPage();
    expect(panel.loads).toBe(1);
    expect(mockDbService.get).toHaveBeenCalledTimes(1);
    await act(async () => {
      (container.querySelector('[data-panel-reload]') as HTMLButtonElement).click();
    });
    await settle();
    expect(mockDbService.get).toHaveBeenCalledTimes(2);
    expect(panel.loads).toBe(2);
    expect(container.querySelector('[data-panel-label]')?.textContent).toBe('usage of ada@test.local #2');
  });

  it('renders panels in declared order inside the panel column', async () => {
    declared = [new ThoughtsPanel(), new UsagePanel()];
    await mountPage();
    const names = Array.from(container.querySelectorAll('[data-record-panels] [data-record-panel]')).map((el) =>
      el.getAttribute('data-record-panel')
    );
    expect(names).toEqual(['usage', 'thoughts']);
  });

  it('with zero panels the page is byte-equal to the panel-less form page', async () => {
    declared = [];
    await mountPage();
    const withSeam = normalizeIds(container.innerHTML);
    expect(container.querySelector('[data-record-surface]')).toBeNull();

    const plain = document.createElement('div');
    document.body.appendChild(plain);
    const plainRoot = createRoot(plain);
    await act(async () => {
      plainRoot.render(
        <MemoryRouter>
          <FormPage>
            <RecordForm table={new UserTable()} record={{ ...stored }} />
          </FormPage>
        </MemoryRouter>
      );
    });
    await settle();
    expect(withSeam).toBe(normalizeIds(plain.innerHTML));
    act(() => {
      plainRoot.unmount();
    });
    plain.remove();
  });

  it('a panel hidden by the gate never loads and never paints', async () => {
    const panel = new UsagePanel();
    declared = [panel];
    setUser(['users']);
    await mountPage();
    expect(panel.loads).toBe(0);
    expect(container.querySelector('[data-record-surface]')).toBeNull();
    expect(container.textContent).toContain('Email');
  });

  it('placement is derived: stacked below the form, a column beside it from lg', async () => {
    declared = [new UsagePanel()];
    await mountPage();
    const surface = container.querySelector('[data-record-surface]') as HTMLElement;
    const surfaceCss = cssFor(surface);
    expect(surfaceCss).toContain('flex-direction: column');
    expect(surfaceCss).toMatch(/@media \(min-width: ?1200px\)[\s\S]*flex-direction: row/);
    const column = container.querySelector('[data-record-panels]') as HTMLElement;
    expect(cssFor(column)).toMatch(/@media \(min-width: ?1200px\)[\s\S]*width: 480px/);
    // the form keeps its stock card
    expect(surface.querySelector('.MuiPaper-root')).toBeTruthy();
  });

  it('phone: the panels stack below the full-bleed form in the one scroller', async () => {
    phoneMode = true;
    try {
      declared = [new UsagePanel()];
      await mountPage();
      const host = container.querySelector('[data-phone-fullbleed]') as HTMLElement;
      expect(host).toBeTruthy();
      expect(container.querySelector('[data-record-surface]')).toBeNull();
      const order = Array.from(host.children).map((child) => child.hasAttribute('data-record-panels'));
      expect(order[order.length - 1]).toBe(true);
      expect(host.querySelector('[data-record-panel="usage"]')).toBeTruthy();
      expect(host.textContent).toContain('Email');
    } finally {
      phoneMode = false;
    }
  });
});
