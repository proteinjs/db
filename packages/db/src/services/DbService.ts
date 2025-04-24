import { Service, serviceFactory } from '@proteinjs/service';
import { Table } from '../Table';
import { Record } from '../Record';
import { QueryBuilder } from '@proteinjs/db-query';

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
  delete<T extends R>(table: Table<T>, query: Query<T>): Promise<number>;
  query<T extends R>(table: Table<T>, query: Query<T>, options?: QueryOptions<T>): Promise<T[]>;
  getRowCount<T extends R>(table: Table<T>, query?: Query<T>): Promise<number>;
}
