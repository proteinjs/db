/**
 * A ROW-LEVEL capability denial (distinct from `TableAuthError`, which denies at the table door).
 *
 * Raised when a caller passes the table's door auth but lacks the per-row capability a
 * capability-scoped column enforces (e.g. a `SharedRecord`'s permission grants): inserting into a
 * permission scope the caller cannot write, or an id-targeted single-row write that matched zero
 * rows purely because the caller's grant level is insufficient. The point is to turn what used to
 * be a SILENT zero-row result — which a caller (and an agent tool acting for them) cannot tell
 * apart from a genuine no-op — into a signal a client can surface as "you don't have access".
 *
 * Name-tagged rather than relying on `instanceof`: the prototype chain is unreliable across
 * package compile targets (same reason `TableAuthError` / `ServiceError` check `name`).
 */
export class RecordAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordAccessError';
  }
}

export const isRecordAccessError = (error: unknown): error is RecordAccessError =>
  !!error && typeof error === 'object' && (error as { name?: string }).name === 'RecordAccessError';
