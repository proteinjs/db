/**
 * @jest-environment jsdom
 *
 * RecordTable functional gaps (task #53 part 2):
 *  - item 2: bulk-delete routes through the confirmation dialog — the db delete only runs after
 *    the user confirms (the immediate bulk-delete repro).
 *  - item 6: the table titles as the plural human name ('Users'), not '<Name> Table'.
 */
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from 'react-query';
import { StaticTableLoader } from '@proteinjs/ui';
import { Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import { RecordTable } from '../src/table/RecordTable';

const mockDb = {
  delete: jest.fn(async () => 1),
};

jest.mock('@proteinjs/db', () => ({
  ...jest.requireActual('@proteinjs/db'),
  getDb: () => mockDb,
}));

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no IntersectionObserver (the table's infinite-scroll sentinel); a quiet stub is
// enough — these tests never page.
class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).IntersectionObserver = StubIntersectionObserver;

// The delete affordance now DERIVES from the table's auth doors (recordTableDerivedAffordances
// suite); this no-auth-block table defaults admin-only, so these dialog-semantics tests run as
// an admin. Resolve the exact UserAuth instance TableAuth consults — through db's own graph.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { UserAuth } = require(
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require.resolve('@proteinjs/user-auth', { paths: [require('path').dirname(require.resolve('@proteinjs/db'))] })
);

interface User extends Record {
  email: string;
}

class UserTable extends Table<User> {
  public name = 'user';
  public columns = withRecordColumns<User>({
    email: new StringColumn('email'),
  });
}

const rows: User[] = [{ id: 'u-1', email: 'a@n3xa.io' } as User, { id: 'u-2', email: 'b@n3xa.io' } as User];

describe('RecordTable', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.clearAllMocks();
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

  const mount = async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <RecordTable
              table={new UserTable()}
              tableLoader={new StaticTableLoader(rows, undefined as any)}
              columns={['email']}
            />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    // Let react-query resolve the first page
    for (let i = 0; i < 5 && !document.body.textContent?.includes('a@n3xa.io'); i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(document.body.textContent).toContain('a@n3xa.io');
  };

  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  const dialog = () => document.querySelector('[role="dialog"]');

  it('titles as the plural human name, not "<Name> Table" (item 6)', async () => {
    await mount();

    expect(document.body.textContent).toContain('Users');
    expect(document.body.textContent).not.toContain('User Table');
  });

  it('bulk-delete acts only after the dialog confirms (the immediate bulk-delete repro, item 2)', async () => {
    await mount();

    const rowCheckbox = document.querySelector('input[aria-label="Select row"]') as HTMLInputElement;
    await click(rowCheckbox);

    const deleteButton = document.querySelector('button[aria-label="Delete selected rows"]');
    expect(deleteButton).not.toBeNull();
    await click(deleteButton!);

    expect(mockDb.delete).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain('Delete 1 row?');
    expect(dialog()!.textContent).toContain('Users');

    const confirm = Array.from(dialog()!.querySelectorAll('button')).find((b) => b.textContent === 'Delete')!;
    await click(confirm);

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });

  it('cancel leaves the rows alone', async () => {
    await mount();

    await click(document.querySelector('input[aria-label="Select row"]')!);
    await click(document.querySelector('button[aria-label="Delete selected rows"]')!);
    const cancel = Array.from(dialog()!.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!;
    await click(cancel);

    expect(mockDb.delete).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });
});
