import {
  applyArrayMembershipOps,
  computeArrayMembershipOps,
  ArrayMembershipOp,
} from '../src/reference/ArrayMembershipOps';
import { overlayPreservedPaths } from '../src/UpdatePreserving';

const replay = (before: string[], after: string[]) =>
  applyArrayMembershipOps(before, computeArrayMembershipOps(before, after)).ids;

describe('computeArrayMembershipOps + applyArrayMembershipOps', () => {
  test('replaying the computed ops on the before-list yields exactly the after-list', () => {
    const cases: Array<[string[], string[]]> = [
      [[], []],
      [[], ['a']],
      [['a'], []],
      [
        ['a', 'b', 'c'],
        ['a', 'b', 'c'],
      ],
      [
        ['a', 'b', 'c'],
        ['a', 'c'],
      ],
      [
        ['a', 'c'],
        ['a', 'b', 'c'],
      ],
      [
        ['a', 'b', 'c'],
        ['c', 'b', 'a'],
      ],
      [
        ['a', 'b', 'c', 'd', 'e'],
        ['e', 'x', 'a', 'c'],
      ],
      [
        ['a', 'b'],
        ['x', 'y', 'z'],
      ],
      [
        ['a', 'b', 'c', 'd'],
        ['b', 'd', 'a', 'c'],
      ],
    ];
    for (const [before, after] of cases) {
      expect(replay(before, after)).toEqual(after);
    }
  });

  test('no-op diff computes zero ops and apply reports unchanged', () => {
    const ops = computeArrayMembershipOps(['a', 'b'], ['a', 'b']);
    expect(ops).toEqual([]);
    expect(applyArrayMembershipOps(['a', 'b'], ops).changed).toBe(false);
  });

  test('unchanged relative order of survivors emits no move ops (pure adds/removes)', () => {
    const ops = computeArrayMembershipOps(['a', 'b', 'c', 'd'], ['a', 'c', 'd', 'e']);
    expect(ops).toEqual([
      { op: 'remove', id: 'b' },
      { op: 'add', id: 'e', afterId: 'd' },
    ]);
  });

  test('CONVERGENCE: concurrent removes of different ids both land regardless of commit order', () => {
    // Client A removes x, client B removes y; each computed against the same base.
    const base = ['x', 'y', 'z'];
    const opsA = computeArrayMembershipOps(base, ['y', 'z']);
    const opsB = computeArrayMembershipOps(base, ['x', 'z']);

    const abOrder = applyArrayMembershipOps(applyArrayMembershipOps(base, opsA).ids, opsB).ids;
    const baOrder = applyArrayMembershipOps(applyArrayMembershipOps(base, opsB).ids, opsA).ids;
    expect(abOrder).toEqual(['z']);
    expect(baOrder).toEqual(['z']);
  });

  test('CONVERGENCE: concurrent adds of different ids both survive regardless of commit order', () => {
    const base = ['a'];
    const opsA = computeArrayMembershipOps(base, ['a', 'p']); // A appends p
    const opsB = computeArrayMembershipOps(base, ['a', 'q']); // B appends q

    const abOrder = applyArrayMembershipOps(applyArrayMembershipOps(base, opsA).ids, opsB).ids;
    const baOrder = applyArrayMembershipOps(applyArrayMembershipOps(base, opsB).ids, opsA).ids;
    expect(new Set(abOrder)).toEqual(new Set(['a', 'p', 'q']));
    expect(new Set(baOrder)).toEqual(new Set(['a', 'p', 'q']));
  });

  test('CONVERGENCE: the founder burst — three sequential deletes converge under ANY commit order', () => {
    // In-memory the client deletes d, then e, then f (each delta computed
    // against its own pre-state, as deleteThought does). The wire commits in a
    // reordered sequence (Spanner abort/retry): every permutation must end at
    // the fully-deleted list — the pre-fix full-list snapshots resurrect rows.
    const s0 = ['a', 'd', 'e', 'f'];
    const del1 = computeArrayMembershipOps(s0, ['a', 'e', 'f']);
    const del2 = computeArrayMembershipOps(['a', 'e', 'f'], ['a', 'f']);
    const del3 = computeArrayMembershipOps(['a', 'f'], ['a']);

    const permutations: ArrayMembershipOp[][][] = [
      [del1, del2, del3],
      [del1, del3, del2],
      [del2, del1, del3],
      [del2, del3, del1],
      [del3, del1, del2],
      [del3, del2, del1],
    ];
    for (const order of permutations) {
      let ids = s0;
      for (const ops of order) {
        ids = applyArrayMembershipOps(ids, ops).ids;
      }
      expect(ids).toEqual(['a']);
    }
  });

  test('anchors: missing afterId appends at the end; null afterId inserts at the head; moves of removed ids are dropped', () => {
    expect(applyArrayMembershipOps(['a', 'b'], [{ op: 'add', id: 'n', afterId: 'gone' }]).ids).toEqual(['a', 'b', 'n']);
    expect(applyArrayMembershipOps(['a', 'b'], [{ op: 'add', id: 'n', afterId: null }]).ids).toEqual(['n', 'a', 'b']);
    expect(applyArrayMembershipOps(['a', 'b'], [{ op: 'move', id: 'gone', afterId: 'a' }]).ids).toEqual(['a', 'b']);
    expect(applyArrayMembershipOps(['a', 'b'], [{ op: 'add', id: 'b', afterId: null }]).ids).toEqual(['b', 'a']);
  });
});

describe('overlayPreservedPaths', () => {
  test('preserves the committed text content into a structural payload (the class-2 kill)', () => {
    const committed = { content: 'Tab beta', type: 'body1' };
    const incoming = { content: '', type: 'h6', fontSize: 12 };
    expect(overlayPreservedPaths(committed, incoming, ['content'], 'string')).toEqual({
      content: 'Tab beta',
      type: 'h6',
      fontSize: 12,
    });
    // The incoming payload object is not mutated.
    expect(incoming.content).toBe('');
  });

  test('nested path (composite text object)', () => {
    const committed = { content: { thoughtTypeId: 't', thoughtObject: { content: 'typed', type: 'body1' } } };
    const incoming = { content: { thoughtTypeId: 't', thoughtObject: { content: '', type: 'h3' } } };
    const out: any = overlayPreservedPaths(committed, incoming, ['content.thoughtObject.content'], 'string');
    expect(out.content.thoughtObject).toEqual({ content: 'typed', type: 'h3' });
  });

  test('whenType guards shape transitions: committed non-string content is not dragged into a new shape', () => {
    const committedComposite = { content: { thoughtTypeId: 't', thoughtObject: { content: 'x' } } };
    const incomingPlain = { content: 'fresh', type: 'body1' };
    expect(overlayPreservedPaths(committedComposite, incomingPlain, ['content'], 'string')).toEqual(incomingPlain);
  });

  test('missing committed path keeps the incoming value (facet-init seeding survives)', () => {
    const committed = { someOtherField: 1 };
    const incoming = { content: 'seeded from description', type: 'body1' };
    expect(overlayPreservedPaths(committed, incoming, ['content'], 'string')).toEqual(incoming);
  });

  test('incoming payload lacking the path parent is left untouched', () => {
    const committed = { content: { thoughtTypeId: 't', thoughtObject: { content: 'x' } } };
    const incoming = { plain: true };
    expect(overlayPreservedPaths(committed, incoming, ['content.thoughtObject.content'], 'string')).toEqual(incoming);
  });
});
