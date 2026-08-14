/**
 * QueryCursorLoader (src/table/QueryCursorLoader.ts) as the thin `CursorLoader` adapter over
 * the db-owned `CursorWindowPager`: react-query key derivation, string-cursor encode/decode
 * threading into the pager's lexicographic window queries (primary axis + `id` tiebreak), and
 * exhaustion (short window, and the null-tail rule: NULL sort-value rows collect at the tail
 * under the sort; a null can't anchor a continuation, so paging stops). The db round trip is
 * injected through the pager's `options.db` seam via the house internals-cast pattern — no
 * module mocking.
 */
import moment from 'moment';
import { Db, QueryBuilder, SortCriteria, Table } from '@proteinjs/db';
import { QueryCursorLoader } from '../src/table/QueryCursorLoader';
// Load the reflection source graph so the house Serializer's custom serializers (moments)
// are registered — cursor encode/decode fidelity rides them.
import '../generated/index';

type Row = {
  id: string;
  created: moment.Moment;
  updated: moment.Moment;
  lastActivityAt?: moment.Moment | null;
  isPinned?: boolean;
};

const table = { name: 'test_content' } as Table<Row>;
const sort: SortCriteria<Row>[] = [{ field: 'lastActivityAt', desc: true }];
const createQuery = () => new QueryBuilder<Row>(table.name);

const staged: { rows: Row[] } = { rows: [] };
const executed: QueryBuilder<Row>[] = [];
const stubDb = {
  query: async (_table: unknown, qb: QueryBuilder<Row>) => {
    executed.push(qb);
    return staged.rows;
  },
} as unknown as Db;

/** House pattern: private internals reachable via a typed cast on the instance. */
type LoaderInternals = { pager: { options?: { db?: Db } } };

const loaderWithStubDb = (sortCriteria?: SortCriteria<Row>[], query: () => QueryBuilder<Row> = createQuery) => {
  const loader = new QueryCursorLoader<Row>(table, query, sortCriteria);
  (loader as unknown as LoaderInternals).pager.options = { db: stubDb };
  return loader;
};

const graphNodes = (qb: QueryBuilder<Row>): any[] => qb.graph.nodes().map((id: string) => qb.graph.node(id));
const conditionNodes = (qb: QueryBuilder<Row>) => graphNodes(qb).filter((node) => node?.type === 'CONDITION');
const paginationNode = (qb: QueryBuilder<Row>) => graphNodes(qb).find((node) => node?.type === 'PAGINATION');
const sortNodes = (qb: QueryBuilder<Row>) => graphNodes(qb).filter((node) => node?.type === 'SORT');

const dated = (id: string, at: string | null): Row => ({
  id,
  created: moment(),
  updated: moment(),
  lastActivityAt: at ? moment(at) : null,
});

beforeEach(() => {
  staged.rows = [];
  executed.length = 0;
});

describe('reactQueryKeys', () => {
  it('names the data set after the table and the query after its serialized query + sort', () => {
    const loader = new QueryCursorLoader<Row>(table, createQuery, sort);
    expect(loader.reactQueryKeys.dataKey).toBe('test_content');
    // Identical construction = identical identity (warm cache across remounts)...
    const twin = new QueryCursorLoader<Row>(table, createQuery, sort);
    expect(twin.reactQueryKeys.dataQueryKey).toBe(loader.reactQueryKeys.dataQueryKey);
    // ...while a different query or sort is a different identity.
    const narrowed = new QueryCursorLoader<Row>(
      table,
      () => createQuery().condition({ field: 'isPinned', operator: '=', value: true }),
      sort
    );
    expect(narrowed.reactQueryKeys.dataQueryKey).not.toBe(loader.reactQueryKeys.dataQueryKey);
    const resorted = new QueryCursorLoader<Row>(table, createQuery, [{ field: 'lastActivityAt', desc: false }]);
    expect(resorted.reactQueryKeys.dataQueryKey).not.toBe(loader.reactQueryKeys.dataQueryKey);
  });
});

describe('loadWindow — cursor threading', () => {
  it('the first window carries no cursor conditions — the sort (with id tiebreak) and the window pagination', async () => {
    const loader = loaderWithStubDb(sort);
    staged.rows = [];
    await loader.loadWindow(null, 30);
    expect(executed).toHaveLength(1);
    const qb = executed[0];
    expect(conditionNodes(qb)).toHaveLength(0);
    expect(paginationNode(qb)).toMatchObject({ start: 0, end: 30 });
    expect(sortNodes(qb).map((node) => node.criteria)).toEqual([
      { field: 'lastActivityAt', desc: true },
      { field: 'id', desc: false },
    ]);
  });

  it('a full window returns a string cursor; feeding it back threads the lexicographic continuation', async () => {
    const loader = loaderWithStubDb(sort);
    const rows = [
      dated('a', '2026-08-10T12:00:00.000Z'),
      dated('b', '2026-08-09T12:00:00.000Z'),
      dated('c', '2026-08-08T12:00:00.000Z'),
    ];
    staged.rows = rows;
    const first = await loader.loadWindow(null, 3);
    expect(first.rows).toBe(rows);
    expect(typeof first.nextCursor).toBe('string');

    staged.rows = [];
    await loader.loadWindow(first.nextCursor, 3);
    const qb = executed[1];
    // Past-on-axis OR (equal-on-axis AND past-on-id), anchored at the tail row 'c' — with the
    // moment surviving the string cursor round trip.
    const conditions = conditionNodes(qb);
    expect(conditions).toHaveLength(3);
    const past = conditions.find((node) => node.operator === '<');
    expect(past).toMatchObject({ field: 'lastActivityAt' });
    expect(moment.isMoment(past.value)).toBe(true);
    expect(past.value.toISOString()).toBe(rows[2].lastActivityAt!.toISOString());
    expect(conditions.find((node) => node.operator === '=')).toMatchObject({ field: 'lastActivityAt' });
    expect(conditions.find((node) => node.operator === '>')).toMatchObject({ field: 'id', value: 'c' });
  });

  it('every window builds on a FRESH query — cursor conditions never accumulate across windows', async () => {
    const loader = loaderWithStubDb(sort);
    staged.rows = [
      dated('a', '2026-08-10T12:00:00.000Z'),
      dated('b', '2026-08-09T12:00:00.000Z'),
      dated('c', '2026-08-08T12:00:00.000Z'),
    ];
    const first = await loader.loadWindow(null, 3);
    staged.rows = [
      dated('d', '2026-08-07T12:00:00.000Z'),
      dated('e', '2026-08-06T12:00:00.000Z'),
      dated('f', '2026-08-05T12:00:00.000Z'),
    ];
    const second = await loader.loadWindow(first.nextCursor, 3);
    staged.rows = [];
    await loader.loadWindow(second.nextCursor, 3);
    expect(conditionNodes(executed[2])).toHaveLength(3);
  });
});

describe('loadWindow — exhaustion', () => {
  it('a short window is exhausted (null cursor)', async () => {
    const loader = loaderWithStubDb(sort);
    staged.rows = [dated('a', '2026-08-10T12:00:00.000Z')];
    const window = await loader.loadWindow(null, 3);
    expect(window.nextCursor).toBeNull();
  });

  it('a full window with a NULL sort-value tail is exhausted (null rows collect at the tail; no anchor)', async () => {
    const loader = loaderWithStubDb(sort);
    staged.rows = [dated('a', '2026-08-10T12:00:00.000Z'), dated('b', '2026-08-09T12:00:00.000Z'), dated('c', null)];
    const window = await loader.loadWindow(null, 3);
    expect(window.nextCursor).toBeNull();
  });
});
