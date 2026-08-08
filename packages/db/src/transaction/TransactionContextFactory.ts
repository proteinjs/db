import { Loadable, SourceRepository } from '@proteinjs/reflection';

export const getDefaultTransactionContextFactory = () =>
  SourceRepository.get().object<DefaultTransactionContextFactory>('@proteinjs/db/DefaultTransactionContextFactory');

/** See {@link TransactionContextData.postCommitHooks} and `Db.runAfterCommit`. */
export type PostCommitHook = () => void | Promise<void>;

export interface TransactionContextData {
  currentTransaction?: any;
  /**
   * Hooks queued to run after the current transaction COMMITS — and never on rollback: a hook
   * queued for a write that gets rolled back dies with the write. Seeded by `Db.runTransaction`
   * on the ambient context so every `Db` instance created inside the transaction (table
   * watchers, nested helpers) shares one queue; registered via `Db.runAfterCommit`, drained by
   * `Db.runTransaction` once the driver reports the commit durable.
   */
  postCommitHooks?: PostCommitHook[];
}

export interface DefaultTransactionContextFactory extends Loadable {
  getTransactionContext(): TransactionContextData;
  runInContext<T>(transaction: any, fn: () => Promise<T>): Promise<T>;
}
