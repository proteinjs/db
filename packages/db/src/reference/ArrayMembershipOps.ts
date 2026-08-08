/**
 * Commutative membership operations for `ReferenceArrayColumn` values.
 *
 * Motivation (the write-side lost-update class): a client writer that persists a
 * reference-array column as a FULL ID LIST snapshots its in-memory state — when two
 * such writes race (fire-and-forget issuance + driver-level abort/retry can commit
 * an earlier-issued transaction later), the last commit wins wholesale and erases
 * the other writer's committed membership change. Expressing membership changes as
 * ops (add/remove/move) applied read-modify-write against COMMITTED truth inside a
 * transaction makes concurrent writes converge instead of clobber:
 * `remove(x)` + `remove(y)` in any commit order removes both; `add(x)` + `add(y)`
 * keeps both.
 *
 * `applyArrayMembershipOps` is the single applier used by `Db.updateArrayMembership`
 * (server-side RMW) — and by any test that needs the committed rule as importable
 * truth. `computeArrayMembershipOps` derives the minimal op set from a
 * before/after id-list pair, for callers whose op layer only knows list states.
 */

export type ArrayMembershipOp =
  /** Insert `id` after `afterId` (`null` = at the head). If `id` is already present it is repositioned. */
  | { op: 'add'; id: string; afterId: string | null }
  /** Remove `id`. No-op when absent. */
  | { op: 'remove'; id: string }
  /** Reposition `id` after `afterId` (`null` = at the head). No-op when `id` is absent (a concurrent remove wins). */
  | { op: 'move'; id: string; afterId: string | null };

export type ArrayMembershipUpdate = {
  /** The record whose array column is being updated. */
  recordId: string;
  /** Property name of the `ReferenceArrayColumn` on the table. */
  columnPropertyName: string;
  /** Ops applied in order against the committed id list. */
  ops: ArrayMembershipOp[];
};

/**
 * Apply membership ops to an id list. Pure; returns a new array and whether it
 * differs from the input.
 *
 * Anchor resolution (`afterId`) against a diverged committed list is
 * convergence-by-anchor: a missing anchor appends at the end (the anchor was
 * concurrently removed — the element still lands in the list, order is
 * best-effort), `afterId: null` inserts at the head.
 */
export function applyArrayMembershipOps(
  currentIds: string[],
  ops: ArrayMembershipOp[]
): { ids: string[]; changed: boolean } {
  const ids = [...currentIds];
  for (const op of ops) {
    if (op.op === 'remove') {
      const idx = ids.indexOf(op.id);
      if (idx !== -1) {
        ids.splice(idx, 1);
      }
      continue;
    }

    if (op.op === 'move' && ids.indexOf(op.id) === -1) {
      // Move of a concurrently-removed element: the remove intent wins.
      continue;
    }

    // add (insert or reposition) and move (reposition) share placement logic.
    const existingIdx = ids.indexOf(op.id);
    if (existingIdx !== -1) {
      ids.splice(existingIdx, 1);
    }
    if (op.afterId === null) {
      ids.unshift(op.id);
    } else {
      const anchorIdx = ids.indexOf(op.afterId);
      if (anchorIdx === -1) {
        ids.push(op.id);
      } else {
        ids.splice(anchorIdx + 1, 0, op.id);
      }
    }
  }

  const changed = ids.length !== currentIds.length || ids.some((id, i) => id !== currentIds[i]);
  return { ids, changed };
}

/**
 * Compute the op set that transforms `beforeIds` into `afterIds`.
 *
 * Removes first, then a single walk of `afterIds` emitting `add` for new
 * elements and `move` for surviving elements whose relative order changed.
 * Moves are minimized via the longest increasing subsequence of surviving
 * elements (elements on the LIS stay put; everything else moves). Replaying
 * the result on `beforeIds` yields exactly `afterIds`; replaying it on a
 * DIVERGED committed list converges by anchor instead of clobbering.
 */
export function computeArrayMembershipOps(beforeIds: string[], afterIds: string[]): ArrayMembershipOp[] {
  const before = beforeIds;
  const after = afterIds;
  const beforeSet = new Set(before);
  const afterSet = new Set(after);

  const ops: ArrayMembershipOp[] = [];
  for (const id of before) {
    if (!afterSet.has(id)) {
      ops.push({ op: 'remove', id });
    }
  }

  // Surviving elements, in after-order, with their positions in `before`.
  const surviving = after.filter((id) => beforeSet.has(id));
  const beforeIndex = new Map(before.map((id, i) => [id, i] as const));
  const stable = longestIncreasingSubsequence(surviving.map((id) => beforeIndex.get(id) as number));
  const stableIds = new Set(stable.map((i) => surviving[i]));

  for (let i = 0; i < after.length; i++) {
    const id = after[i];
    const afterId = i === 0 ? null : after[i - 1];
    if (!beforeSet.has(id)) {
      ops.push({ op: 'add', id, afterId });
    } else if (!stableIds.has(id)) {
      ops.push({ op: 'move', id, afterId });
    }
  }

  return ops;
}

/** Indices (into the input array) of one longest strictly-increasing subsequence. */
function longestIncreasingSubsequence(values: number[]): number[] {
  const tailIndices: number[] = [];
  const prev: number[] = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tailIndices.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tailIndices[mid]] < values[i]) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo > 0) {
      prev[i] = tailIndices[lo - 1];
    }
    tailIndices[lo] = i;
  }
  const result: number[] = [];
  let k = tailIndices.length > 0 ? tailIndices[tailIndices.length - 1] : -1;
  while (k !== -1) {
    result.unshift(k);
    k = prev[k];
  }
  return result;
}
