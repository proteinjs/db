/**
 * Support for `Db.updatePreserving` / `Transaction.updatePreserving`: an update
 * whose payload carries a column value the writer only PARTIALLY owns — the
 * listed sub-paths belong to other writers, so their committed values are
 * preserved (overlaid into the payload read-modify-write) instead of being
 * clobbered by whatever stale copy the writer's snapshot happened to hold.
 *
 * The motivating case: a structural editor operation changes non-text fields of
 * a JSON object column (styling, child overrides) while a debounced text save
 * owns the object's text content. The structural payload's `content` is stale
 * by construction (text syncs into the record at save time, not per keystroke);
 * writing it would erase a concurrently committed text save. Preserving
 * `content` from the committed row makes the two writers commute.
 */

export type PreservedPath = {
  /** Property name of the column whose payload value should have paths preserved. */
  columnPropertyName: string;
  /** Dot-separated paths inside the column value (plain-JSON columns only). */
  paths: string[];
  /**
   * Only overlay a committed value whose `typeof` matches. Guards shape
   * transitions: when the op legitimately changes the column's SHAPE (e.g. a
   * text object becoming a composite wrapper), a committed value of a
   * different type must not be dragged into the new shape.
   */
  whenType?: 'string' | 'number' | 'boolean' | 'object';
};

/**
 * Overlay committed values at `paths` into a clone of `incomingValue`.
 * Pure: returns the (possibly cloned) value to write. Only plain-JSON values
 * are supported (the clone is JSON-based).
 */
export function overlayPreservedPaths(
  committedValue: unknown,
  incomingValue: unknown,
  paths: string[],
  whenType?: PreservedPath['whenType']
): unknown {
  if (incomingValue == null || committedValue == null) {
    return incomingValue;
  }

  let result: unknown | undefined;
  for (const path of paths) {
    const committedAtPath = deepGet(committedValue, path);
    if (committedAtPath === undefined) {
      continue;
    }
    if (whenType && typeof committedAtPath !== whenType) {
      continue;
    }
    if (deepGet(result ?? incomingValue, path) === committedAtPath) {
      continue;
    }
    if (result === undefined) {
      result = JSON.parse(JSON.stringify(incomingValue));
    }
    deepSet(result, path, committedAtPath);
  }

  return result === undefined ? incomingValue : result;
}

function deepGet(value: unknown, path: string): unknown {
  let current: any = value;
  for (const key of path.split('.')) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function deepSet(value: unknown, path: string, pathValue: unknown): void {
  const keys = path.split('.');
  let current: any = value;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = current?.[keys[i]];
    if (next == null || typeof next !== 'object') {
      // The incoming value doesn't have this path's parent — nothing to preserve into.
      return;
    }
    current = next;
  }
  current[keys[keys.length - 1]] = pathValue;
}
