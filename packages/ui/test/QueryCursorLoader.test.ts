/**
 * QueryCursorLoader (src/table/QueryCursorLoader.ts) at the pure level: react-query key
 * derivation, cursor threading into the window query, and next-cursor derivation — including
 * the null-tail exhaustion rule (NULL cursor-field rows collect at the tail under the sort;
 * a null tail can't anchor a cursor, so paging stops). Window queries are inspected through
 * the QueryBuilder graph; loadWindow's db round-trip is exercised with a stubbed getDb.
 */
import moment from 'moment';

const stagedRows: { rows: unknown[] } = { rows: [] };
const queries: unknown[] = [];
const stubDb = {
  query: async (_table: unknown, qb: unknown) => {
    queries.push(qb);
    return stagedRows.rows;
  },
};

jest.mock('@proteinjs/db', () => ({
  ...jest.requireActual('@proteinjs/db'),
  getDb: () => stubDb,
}));

import { QueryBuilder, SortCriteria, Table } from '@proteinjs/db';
import { CursorValue } from '@proteinjs/ui';
import { QueryCursorLoader } from '../src/table/QueryCursorLoader';

type Row = {
  id: string;
  created: moment.Moment;
  updated: moment.Moment;
  lastActivityAt?: moment.Moment;
  isPinned?: boolean;
};

const table = { name: 'test_content' } as Table<Row>;
const sort: SortCriteria<Row>[] = [{ field: 'lastActivityAt', desc: true }];
const createQuery = () => new QueryBuilder<Row>(table.name);

/** House pattern: private helpers reachable via a typed cast on the instance. */
type LoaderInternals = {
  buildWindowQuery(cursor: CursorValue | null, windowSize: number): QueryBuilder<Row>;
  deriveNextCursor(rows: Row[], windowSize: number): CursorValue | null;
};

const internals = (loader: QueryCursorLoader<Row>) => loader as unknown as LoaderInternals;

const graphNodes = (qb: QueryBuilder<Row>): any[] => qb.graph.nodes().map((id: string) => qb.graph.node(id));
const conditionNodes = (qb: QueryBuilder<Row>) => graphNodes(qb).filter((node) => node?.type === 'CONDITION');
const paginationNode = (qb: QueryBuilder<Row>) => graphNodes(qb).find((node) => node?.type === 'PAGINATION');
const sortNodes = (qb: QueryBuilder<Row>) => graphNodes(qb).filter((node) => node?.type === 'SORT');

const dated = (id: string, at: string | null): Row => ({
  id,
  created: moment(),
  updated: moment(),
  lastActivityAt: at ? moment(at) : undefined,
});

beforeEach(() => {
  stagedRows.rows = [];
  queries.length = 0;
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

describe('buildWindowQuery — cursor threading', () => {
  it('the first window carries no cursor condition, only the sort and the window pagination', () => {
    const loader = new QueryCursorLoader<Row>(table, createQuery, sort);
    const qb = internals(loader).buildWindowQuery(null, 30);
    expect(conditionNodes(qb)).toHaveLength(0);
    expect(paginationNode(qb)).toMatchObject({ start: 0, end: 30 });
    expect(sortNodes(qb)).toHaveLength(1);
    expect(sortNodes(qb)[0].criteria).toMatchObject({ field: 'lastActivityAt', desc: true });
  });

  it('a cursor becomes `field < cursor` on the primary sort field for a descending sort', () => {
    const loader = new QueryCursorLoader<Row>(table, createQuery, sort);
    const cursor = moment('2026-08-10T12:00:00.000Z');
    const qb = internals(loader).buildWindowQuery(cursor, 30);
    const conditions = conditionNodes(qb);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({ field: 'lastActivityAt', operator: '<' });
    expect(conditions[0].value).toBe(cursor);
    expect(paginationNode(qb)).toMatchObject({ start: 0, end: 30 });
  });

  it('an ascending primary sort flips the cursor operator to `>`', () => {
    const loader = new QueryCursorLoader<Row>(table, createQuery, [{ field: 'lastActivityAt', desc: false }]);
    const qb = internals(loader).buildWindowQuery(5, 10);
    expect(conditionNodes(qb)[0]).toMatchObject({ field: 'lastActivityAt', operator: '>', value: 5 });
  });

  it('every window builds on a FRESH query — cursor conditions never accumulate across windows', () => {
    const loader = new QueryCursorLoader<Row>(table, createQuery, sort);
    internals(loader).buildWindowQuery(moment('2026-08-10T12:00:00.000Z'), 30);
    const second = internals(loader).buildWindowQuery(moment('2026-08-01T12:00:00.000Z'), 30);
    expect(conditionNodes(second)).toHaveLength(1);
  });
});

describe('deriveNextCursor — exhaustion', () => {
  const loader = new QueryCursorLoader<Row>(table, createQuery, sort);

  it('a short window is exhausted', () => {
    expect(internals(loader).deriveNextCursor([dated('a', '2026-08-10T12:00:00.000Z')], 3)).toBeNull();
    expect(internals(loader).deriveNextCursor([], 3)).toBeNull();
  });

  it('a full window anchors the next cursor at its tail', () => {
    const rows = [
      dated('a', '2026-08-10T12:00:00.000Z'),
      dated('b', '2026-08-09T12:00:00.000Z'),
      dated('c', '2026-08-08T12:00:00.000Z'),
    ];
    const next = internals(loader).deriveNextCursor(rows, 3);
    expect(next).toBe(rows[2].lastActivityAt);
  });

  it('a full window with a NULL cursor-field tail is exhausted (null rows collect at the tail; no anchor)', () => {
    const rows = [dated('a', '2026-08-10T12:00:00.000Z'), dated('b', '2026-08-09T12:00:00.000Z'), dated('c', null)];
    expect(internals(loader).deriveNextCursor(rows, 3)).toBeNull();
  });
});

describe('loadWindow', () => {
  it('returns the queried rows with the derived next cursor', async () => {
    const loader = new QueryCursorLoader<Row>(table, createQuery, sort);
    const rows = [
      dated('a', '2026-08-10T12:00:00.000Z'),
      dated('b', '2026-08-09T12:00:00.000Z'),
      dated('c', '2026-08-08T12:00:00.000Z'),
    ];
    stagedRows.rows = rows;
    const window = await loader.loadWindow(null, 3);
    expect(window.rows).toBe(rows);
    expect(window.nextCursor).toBe(rows[2].lastActivityAt);
    // The executed query is the built window query: pagination sized to the window.
    expect(queries).toHaveLength(1);
    expect(paginationNode(queries[0] as QueryBuilder<Row>)).toMatchObject({ start: 0, end: 3 });
  });

  it('returns an exhausted window (null cursor) when the query comes back short', async () => {
    const loader = new QueryCursorLoader<Row>(table, createQuery, sort);
    stagedRows.rows = [dated('a', '2026-08-10T12:00:00.000Z')];
    const window = await loader.loadWindow(moment('2026-08-11T12:00:00.000Z'), 3);
    expect(window.nextCursor).toBeNull();
  });
});
