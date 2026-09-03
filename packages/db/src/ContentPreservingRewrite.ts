/**
 * Marker seam for CONTENT-PRESERVING REWRITES — writes that change how a row is STORED without
 * changing what it SAYS: the encryption lifecycle transitions (adoption backfill, retokenize,
 * key rotation, decrypt-out) and physical-column moves (a legacy JSON column copied into its
 * encrypted STRING successor). The bytes at rest change; the record's content does not.
 *
 * Every content-derived signal in the system must therefore see NOTHING: the record's own
 * `updated` stamp stays as found (the db layer owns that half — see `Db.asContentPreservingRewrite`),
 * and the table watchers that turn content writes into recency bumps, mirror updates, "changed"
 * dots, and change notifications (space-common's ContentReferenceThoughtTableWatcher,
 * space-server's ThoughtRootUpdateNotifyTableWatcher, chat-common's ChatMessageTableWatcher, …)
 * ask {@link isContentPreservingRewrite} and return early. Without this, a deploy-day backfill
 * over every document rewrote every root's `lastActivityAt` to deploy time (home order flattened,
 * every shared document dotted as changed for every recipient) and fired a per-root notify.
 *
 * One owner for the concept: the SYSTEM Db in rewrite mode marks each update payload here; the
 * watchers only read. WeakSet keyed on the payload object — watchers chain the same record object
 * through beforeUpdate/afterUpdate, nothing is serialized into the row, and the marker dies with
 * the write. Anchored on the process global, not module scope: per-package installs put two live
 * copies of @proteinjs/db in one process (symlinked estates), and a module-scoped set would split
 * the mark from its readers (the ServerActivityStamp precedent in thought-common).
 */
const CONTENT_PRESERVING_REWRITES_GLOBAL_KEY = '__proteinjs_db_contentPreservingRewrites';

const getGlobal = (): any => (typeof window !== 'undefined' ? window : globalThis);

const contentPreservingRewrites = (): WeakSet<object> => {
  const global = getGlobal();
  if (!global[CONTENT_PRESERVING_REWRITES_GLOBAL_KEY]) {
    global[CONTENT_PRESERVING_REWRITES_GLOBAL_KEY] = new WeakSet<object>();
  }
  return global[CONTENT_PRESERVING_REWRITES_GLOBAL_KEY];
};

/** Declare that this write payload rewrites stored bytes only — the db layer's half of the seam. */
export function markContentPreservingRewrite(record: object): void {
  contentPreservingRewrites().add(record);
}

/**
 * True when the write carrying this payload is a content-preserving rewrite: content-derived
 * signals (recency, mirrors, notifications) must leave everything exactly as they found it.
 */
export function isContentPreservingRewrite(record: object): boolean {
  return contentPreservingRewrites().has(record);
}
