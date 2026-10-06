/**
 * How a transaction is re-run when the database ABORTS it — a lock conflict the database
 * resolves by aborting one of the transactions in it, delivered at that transaction's next
 * statement or at its commit. The policy is the CALLER's, named at the call, never a default a
 * caller cannot see:
 *
 * - Omitted: the driver's own road — the one right for a durable write, which must land however
 *   long the conflict lasts (on Spanner, the client library's runner re-runs the body on its
 *   backoff ladder inside the driver's configured budget).
 * - `'none'`: one attempt. The abort reaches the caller at once, typed
 *   (`TransactionRetryExhaustedError`).
 * - `{ attempts, maxMs }`: at most `attempts` attempts in all (the first included), and no
 *   attempt starts once `maxMs` milliseconds have passed since the first began; when either
 *   bound is reached the last abort reaches the caller typed. `maxMs` omitted bounds by
 *   attempts alone.
 *
 * A BEST-EFFORT write names a bounded policy: a write that the next write of its kind supersedes
 * anyway (a live progress row rewritten at every step) must not be re-run for minutes against a
 * conflict it will lose — it loses promptly, and the caller handles the typed refusal.
 *
 * The policy belongs to a transaction: a write issued outside any transaction is a transaction
 * of its own and names it at the write (`Db.insert`, `Db.update`); a `Db.runTransaction` body
 * names it on the transaction, and every write inside that body rides it — a write inside a
 * transaction cannot name a policy of its own.
 */
export type TransactionRetryPolicy = 'none' | { attempts: number; maxMs?: number };

/** The options of a transaction — a `Db.runTransaction` body's, or a write's own when it runs outside one. */
export type TransactionOptions = {
  retry?: TransactionRetryPolicy;
};
