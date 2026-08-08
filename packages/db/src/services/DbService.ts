import { Service, serviceFactory } from '@proteinjs/service';
import { Table } from '../Table';
import { Record } from '../Record';
import { QueryBuilder } from '@proteinjs/db-query';
import { ArrayMembershipUpdate } from '../reference/ArrayMembershipOps';
import { PreservedPath } from '../UpdatePreserving';

export const getDbService = serviceFactory<DbService>('@proteinjs/db/DbService');

export type Query<T> = ObjectQuery<T> | QueryBuilder<T>;
export type ObjectQuery<T> = Partial<{ [P in keyof T]: any }>;
export type QueryOptions<T> = {
  /**
   * Configuration for preloading `Reference` and `ReferenceArray` fields.
   * @property {boolean} enabled - Whether preloading is active.
   * @property {Array<keyof T>} [includeColumns] - Array of property names from T to include in preloading. If provided, will only preload these columns.
   * @property {Array<keyof T>} [excludeColumns] - Array of property names from T to exclude from preloading.
   */
  preloadReferences?: { enabled: boolean; includeColumns?: Array<keyof T>; excludeColumns?: Array<keyof T> };
};

export interface DbService<R extends Record = Record> extends Service {
  tableExists<T extends R>(table: Table<T>): Promise<boolean>;
  get<T extends R>(table: Table<T>, query: Query<T>, options?: QueryOptions<T>): Promise<T>;
  insert<T extends R>(table: Table<T>, record: Omit<T, keyof R>): Promise<T>;
  update<T extends R>(table: Table<T>, record: Partial<T>, query?: Query<T>): Promise<number>;
  /**
   * Apply commutative membership ops (add/remove/move) to a `ReferenceArrayColumn`,
   * read-modify-write against COMMITTED truth inside a server-side transaction, so concurrent
   * membership writers converge instead of last-write-wins clobbering each other (the
   * write-side lost-update class).
   *
   * Use when the column has a NAMED multi-writer split — more than one writer changes the
   * list's membership concurrently. Use plain `update` when the column has a single writer,
   * or when the intent genuinely is wholesale assignment of the entire list.
   *
   * Authorization is identical to `update`: the table's `update` grant gates the call, and
   * scoped/column query injection applies to the server-side read-modify-write — a scoped
   * caller can only touch rows they could already update (an out-of-scope record behaves as
   * nonexistent: returns 0).
   *
   * @returns the update count (0 when the ops are a no-op against committed truth, or the
   * record does not exist / is not visible to the caller)
   */
  updateArrayMembership<T extends R>(table: Table<T>, update: ArrayMembershipUpdate): Promise<number>;
  /**
   * Update with committed-truth preservation for column sub-paths the writer does not own:
   * the payload's listed paths are overlaid with their committed values (read in the same
   * server-side transaction), so this write commutes with the writers that own those paths.
   * Plain-JSON columns only.
   *
   * Use when ownership of a column's VALUE is split across writers by sub-path (e.g. a
   * structural editor op writes an object's styling while a debounced text save owns
   * `content` — the structural payload's `content` is stale by construction). Use plain
   * `update` when the writer owns the whole value it writes.
   *
   * Authorization is identical to `update` (update grant, scoped/column query injection,
   * `serviceProtectedColumns` enforced on the payload).
   *
   * @returns the update count (0 when the record does not exist / is not visible to the caller)
   */
  updatePreserving<T extends R>(table: Table<T>, record: Partial<T>, preserve: PreservedPath[]): Promise<number>;
  delete<T extends R>(table: Table<T>, query: Query<T>): Promise<number>;
  query<T extends R>(table: Table<T>, query: Query<T>, options?: QueryOptions<T>): Promise<T[]>;
  getRowCount<T extends R>(table: Table<T>, query?: Query<T>): Promise<number>;
}
