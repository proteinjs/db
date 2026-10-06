/**
 * A transaction the database aborted (a lock conflict it resolved against this transaction) that
 * its caller's retry policy (`TransactionRetryPolicy`) did not allow to be re-run any further:
 * every attempt the policy allowed was made, or its time budget was spent, and the last one was
 * aborted too. The driver throws it in place of the database's own abort, so a caller that chose
 * a bounded policy — a best-effort write that loses to the next write of its kind — takes the
 * refusal by type and decides what to do with it: nothing was written by this transaction, and
 * nothing was retried behind the caller's back.
 *
 * `attempts` is how many attempts were made in all; `elapsedMs` the wall-clock from the first
 * attempt's start to the last abort; `cause` the abort that ended the last attempt (the driver's
 * own error for it — for callers in process; not enumerable, so a serialized error carries none
 * of the backend's words).
 *
 * Name-tagged rather than relying on `instanceof`: the prototype chain is unreliable across
 * package compile targets (the same reason `DuplicateKeyError` checks `name`).
 */
export class TransactionRetryExhaustedError extends Error {
  readonly cause: unknown;

  constructor(
    operation: string,
    readonly attempts: number,
    readonly elapsedMs: number,
    cause: unknown
  ) {
    super(
      `Transaction aborted and not retried further: its retry policy allowed ${attempts} attempt${attempts === 1 ? '' : 's'}, ` +
        `made in ${Math.round(elapsedMs)}ms (${operation})`
    );
    this.name = 'TransactionRetryExhaustedError';
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false, writable: false });
  }
}

export const isTransactionRetryExhaustedError = (error: unknown): error is TransactionRetryExhaustedError =>
  !!error && typeof error === 'object' && (error as { name?: string }).name === 'TransactionRetryExhaustedError';
