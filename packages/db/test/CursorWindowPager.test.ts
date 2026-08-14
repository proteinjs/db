/**
 * CursorWindowPager (src/CursorWindowPager.ts) at the pure level: effective-sort derivation
 * (id tiebreak appended, explicit id ends the list, byValues rejected), lexicographic anchor
 * conditions, next-anchor derivation (short-window and null-tail exhaustion), anchor
 * encode/decode fidelity, and fresh-query-per-window construction. The db round trip is a
 * constructor-injected stub — no module mocking, the pager's `options.db` seam IS the
 * injection point.
 */
import moment from 'moment';
import { QueryBuilder } from '@proteinjs/db-query';
import { AnchoredWindow, CursorAnchor, CursorWindowPager, Db, SortCriteria, Table } from '@proteinjs/db';
// Load the reflection source graph so the house Serializer's custom serializers (moments)
// are registered — anchor encode/decode fidelity rides them.
import '../generated/index';

type Row = {
  id: string;
  name: string;
  seq?: number | null;
  stampedAt?: moment.Moment | null;
};

const table = { name: 'pager_test' } as Table<Row & { created: moment.Moment; updated: moment.Moment }>;
type PagerRow = Row & { created: moment.Moment; updated: moment.Moment };

const staged: { rows: Row[] } = { rows: [] };
const executed: QueryBuilder<PagerRow>[] = [];
const stubDb = {
  query: async (_table: unknown, qb: QueryBuilder<PagerRow>) => {
    executed.push(qb);
    return staged.rows;
  },
} as unknown as Db;

const createQuery = () => new QueryBuilder<PagerRow>(table.name);

const pager = (sort?: SortCriteria<PagerRow>[]) =>
  new CursorWindowPager<PagerRow>(table, createQuery, sort, { db: stubDb });

/** House pattern: private internals reachable via a typed cast on the instance. */
type PagerInternals = {
  effectiveSort: SortCriteria<PagerRow>[];
  buildWindowQuery(anchor: CursorAnchor | null, windowSize: number): QueryBuilder<PagerRow>;
  deriveNextAnchor(rows: Row[], windowSize: number): CursorAnchor | null;
};
const internals = (instance: CursorWindowPager<PagerRow>) => instance as unknown as PagerInternals;

const graphNodes = (qb: QueryBuilder<PagerRow>): any[] => qb.graph.nodes().map((id: string) => qb.graph.node(id));
const conditionNodes = (qb: QueryBuilder<PagerRow>) => graphNodes(qb).filter((node) => node?.type === 'CONDITION');
const logicalNodes = (qb: QueryBuilder<PagerRow>) => graphNodes(qb).filter((node) => node?.type === 'LOGICAL');
const paginationNode = (qb: QueryBuilder<PagerRow>) => graphNodes(qb).find((node) => node?.type === 'PAGINATION');
const sortNodes = (qb: QueryBuilder<PagerRow>) => graphNodes(qb).filter((node) => node?.type === 'SORT');

const row = (id: string, seq: number | null, at?: string | null): Row => ({
  id,
  name: id,
  seq,
  stampedAt: at ? moment(at) : at === null ? null : undefined,
});

beforeEach(() => {
  staged.rows = [];
  executed.length = 0;
});

describe('effective sort', () => {
  it('appends the id tiebreak to the consumer sort', () => {
    const instance = pager([{ field: 'seq', desc: true }]);
    expect(internals(instance).effectiveSort).toEqual([
      { field: 'seq', desc: true },
      { field: 'id', desc: false },
    ]);
  });

  it('no sort = pure id order', () => {
    expect(internals(pager()).effectiveSort).toEqual([{ field: 'id', desc: false }]);
  });

  it('an explicit id criterion ends the list (axes after it can never influence order)', () => {
    const instance = pager([
      { field: 'id', desc: true },
      { field: 'seq', desc: false },
    ]);
    expect(internals(instance).effectiveSort).toEqual([{ field: 'id', desc: true }]);
  });

  it('rejects byValues sorts — a CASE ordering has no comparable cursor axis', () => {
    expect(() => pager([{ field: 'name', byValues: ['a', 'b'] }])).toThrow(/byValues/);
  });
});

describe('buildWindowQuery', () => {
  it('the first window carries no cursor conditions — just the effective sort and the window pagination', () => {
    const qb = internals(pager([{ field: 'seq', desc: false }])).buildWindowQuery(null, 30);
    expect(conditionNodes(qb)).toHaveLength(0);
    expect(paginationNode(qb)).toMatchObject({ start: 0, end: 30 });
    expect(sortNodes(qb).map((node) => node.criteria)).toEqual([
      { field: 'seq', desc: false },
      { field: 'id', desc: false },
    ]);
  });

  it('an anchored window builds the lexicographic continuation: past-on-axis OR (equal-on-axis AND past-on-id)', () => {
    const qb = internals(pager([{ field: 'seq', desc: true }])).buildWindowQuery({ values: [40, 'row-4'] }, 10);
    // Disjunct 1: seq < 40. Disjunct 2: seq = 40 AND id > 'row-4'.
    expect(conditionNodes(qb)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'seq', operator: '<', value: 40 }),
        expect.objectContaining({ field: 'seq', operator: '=', value: 40 }),
        expect.objectContaining({ field: 'id', operator: '>', value: 'row-4' }),
      ])
    );
    expect(conditionNodes(qb)).toHaveLength(3);
    const operators = logicalNodes(qb).map((node) => node.operator);
    expect(operators).toContain('OR');
    expect(operators).toContain('AND');
  });

  it('an ascending axis flips the past operator to `>`', () => {
    const qb = internals(pager([{ field: 'seq', desc: false }])).buildWindowQuery({ values: [40, 'row-4'] }, 10);
    expect(conditionNodes(qb)).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'seq', operator: '>', value: 40 })])
    );
  });

  it('every window builds on a FRESH query — cursor conditions never accumulate', () => {
    const instance = pager([{ field: 'seq', desc: true }]);
    internals(instance).buildWindowQuery({ values: [40, 'row-4'] }, 10);
    const second = internals(instance).buildWindowQuery({ values: [20, 'row-2'] }, 10);
    expect(conditionNodes(second)).toHaveLength(3);
  });
});

describe('deriveNextAnchor', () => {
  const instance = pager([{ field: 'seq', desc: false }]);

  it('a short window is exhausted', () => {
    expect(internals(instance).deriveNextAnchor([row('a', 10)], 3)).toBeNull();
    expect(internals(instance).deriveNextAnchor([], 3)).toBeNull();
  });

  it('a full window anchors at its tail row, one value per effective criterion', () => {
    const anchor = internals(instance).deriveNextAnchor([row('a', 10), row('b', 20), row('c', 30)], 3);
    expect(anchor).toEqual({ values: [30, 'c'] });
  });

  it('a full window with a NULL sort-value tail is exhausted (null rows collect at the tail; no anchor)', () => {
    expect(internals(instance).deriveNextAnchor([row('a', 10), row('b', 20), row('c', null)], 3)).toBeNull();
  });
});

describe('anchor encode/decode', () => {
  it('round-trips values with type fidelity (moments survive)', () => {
    const at = moment('2026-08-10T12:00:00.000Z');
    const encoded = CursorWindowPager.encodeAnchor({ values: [at, 'row-1'] });
    expect(typeof encoded).toBe('string');
    const decoded = CursorWindowPager.decodeAnchor(encoded);
    expect(moment.isMoment(decoded.values[0])).toBe(true);
    expect((decoded.values[0] as moment.Moment).toISOString()).toBe(at.toISOString());
    expect(decoded.values[1]).toBe('row-1');
  });
});

describe('loadWindow', () => {
  it('returns the queried rows with the derived next anchor, querying through the injected db', async () => {
    const instance = pager([{ field: 'seq', desc: false }]);
    staged.rows = [row('a', 10), row('b', 20), row('c', 30)];
    const window: AnchoredWindow<PagerRow> = await instance.loadWindow(null, 3);
    expect(window.rows).toBe(staged.rows);
    expect(window.nextAnchor).toEqual({ values: [30, 'c'] });
    expect(executed).toHaveLength(1);
    expect(paginationNode(executed[0])).toMatchObject({ start: 0, end: 3 });
  });

  it('returns an exhausted window (null anchor) when the query comes back short', async () => {
    const instance = pager([{ field: 'seq', desc: false }]);
    staged.rows = [row('a', 10)];
    const window = await instance.loadWindow({ values: [5, 'z'] }, 3);
    expect(window.nextAnchor).toBeNull();
  });

  it('rejects a nonsensical window size', async () => {
    await expect(pager().loadWindow(null, 0)).rejects.toThrow(/window size/i);
  });
});
