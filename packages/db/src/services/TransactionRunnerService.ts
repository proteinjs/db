import { Service, serviceFactory } from '@proteinjs/service';
import { Operation } from '../transaction/Transaction';

export const getTransactionRunnerService = serviceFactory<TransactionRunnerService>(
  '@proteinjs/db/TransactionRunnerService'
);

/**
 * What a write declares about the rows it depends on.
 *
 * A client that releases a queued write because its page is going away cannot order that write
 * behind the writes it depends on — the page is gone before their answers arrive. The server
 * outlives the page, so the write DECLARES its dependencies and the server honours them.
 */
export type TransactionRunOptions = {
  /**
   * Ids of rows the operations depend on that may not exist yet: the row an update or a
   * membership update targets while its insert is still in flight, the permission source a
   * child row attaches to while the root's own insert (and the owner grant that commits with
   * it) is still landing. Every id must be a row the operations themselves reference. The
   * runner waits, bounded, for each to exist AND be visible to the caller before running the
   * operations; a row that never appears fails the request with a plain clause — never a
   * silent zero-row write, never a hang.
   */
  afterRows?: string[];
};

export interface TransactionRunnerService extends Service {
  run(ops: Operation<any>[], options?: TransactionRunOptions): Promise<void>;
}
