/**
 * An insert the database refused because a row with the same key is already there — the primary
 * key, or any unique index the table declares. `Db.insert` and `Db.insertMany` throw it in place
 * of the driver's own error (which rides as `cause`, never printed: the backend's words quote the
 * colliding key), so a caller for whom "that row already exists" is a branch of its own — an
 * insert-then-update that keeps one row per key under concurrent writers — takes it by type,
 * never by the backend's message text. Which errors are this class is the driver's call
 * (`DbDriver.isDuplicateKeyError`); a driver that declares no classifier lets the backend's error
 * through as it came.
 *
 * Name-tagged rather than relying on `instanceof`: the prototype chain is unreliable across
 * package compile targets (the same reason `RecordAccessError` checks `name`).
 */
export class DuplicateKeyError extends Error {
  /** The driver's error — for callers in process; not enumerable, so a serialized error carries no row key. */
  readonly cause: unknown;

  constructor(tableName: string, cause: unknown) {
    super(`(${tableName}) Insert refused: a row with the same key already exists`);
    this.name = 'DuplicateKeyError';
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false, writable: false });
  }
}

export const isDuplicateKeyError = (error: unknown): error is DuplicateKeyError =>
  !!error && typeof error === 'object' && (error as { name?: string }).name === 'DuplicateKeyError';
