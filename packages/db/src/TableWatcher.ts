import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { QueryBuilder } from '@proteinjs/db-query';
import { Record } from './Record';
import { Table } from './Table';
import { Db } from './Db';

type RequiredProps<T, K extends keyof T> = Omit<T, K> & {
  [P in K]-?: T[P];
};

export type TableWatcherMap<R extends Record = any> = {
  [tableName: string]: {
    beforeInsert: RequiredProps<TableWatcher<R>, 'beforeInsert'>[];
    afterInsert: RequiredProps<TableWatcher<R>, 'afterInsert'>[];
    beforeUpdate: RequiredProps<TableWatcher<R>, 'beforeUpdate'>[];
    afterUpdate: RequiredProps<TableWatcher<R>, 'afterUpdate'>[];
    beforeDelete: RequiredProps<TableWatcher<R>, 'beforeDelete'>[];
    afterDelete: RequiredProps<TableWatcher<R>, 'afterDelete'>[];
  };
};

export const getTableWatcherMap = <R extends Record = any>(): TableWatcherMap<R> => {
  const tableWatcherMap: TableWatcherMap<R> = {};
  const tableWatchers = getTableWatchers();
  for (const tableWatcher of tableWatchers) {
    if (!tableWatcherMap[tableWatcher.table().name]) {
      tableWatcherMap[tableWatcher.table().name] = {
        beforeInsert: [],
        afterInsert: [],
        beforeUpdate: [],
        afterUpdate: [],
        beforeDelete: [],
        afterDelete: [],
      };
    }

    const mapping = tableWatcherMap[tableWatcher.table().name];
    if (tableWatcher.beforeInsert) {
      mapping.beforeInsert.push(tableWatcher as any);
    }

    if (tableWatcher.afterInsert) {
      mapping.afterInsert.push(tableWatcher as any);
    }

    if (tableWatcher.beforeUpdate) {
      mapping.beforeUpdate.push(tableWatcher as any);
    }

    if (tableWatcher.afterUpdate) {
      mapping.afterUpdate.push(tableWatcher as any);
    }

    if (tableWatcher.beforeDelete) {
      mapping.beforeDelete.push(tableWatcher as any);
    }

    if (tableWatcher.afterDelete) {
      mapping.afterDelete.push(tableWatcher as any);
    }
  }

  return tableWatcherMap;
};

export const getTableWatchers = <R extends Record = any>() =>
  SourceRepository.get().objects<TableWatcher<R>>('@proteinjs/db/TableWatcher');

/**
 * Hooks around a table's writes. Every hook's trailing `db` is the Db the invoking write made
 * for its hooks — the write's driver, tables and transaction context AND its system mode — so a
 * watcher's own reads and writes carry the authority of the write that fired it: a system write's
 * follow-on runs as system (a background purge with no session user), a request's as its session.
 * The Db hands it to every hook; a watcher never opens a Db of its own for the write's follow-on.
 * Optional in the type so an implementer that ignores it still conforms.
 */
export interface TableWatcher<R extends Record = Record> extends Loadable {
  name(): string;
  table(): Table<R>;
  beforeInsert?<T extends R>(record: Omit<T, keyof R>, db?: Db): Promise<Omit<T, keyof R>>;
  afterInsert?<T extends R>(record: T, db?: Db): Promise<void>;
  beforeUpdate?<T extends R>(record: Partial<T>, qb: QueryBuilder<T>, db?: Db): Promise<Partial<T>>;
  afterUpdate?<T extends R>(recordUpdateCount: number, record: Partial<T>, qb: QueryBuilder<T>, db?: Db): Promise<void>;
  beforeDelete?<T extends R>(
    recordsToDelete: T[],
    initialQb: QueryBuilder<T>,
    deleteQb: QueryBuilder<T>,
    db?: Db
  ): Promise<void>;
  afterDelete?<T extends R>(
    recordDeleteCount: number,
    deletedRecords: T[],
    initialQb: QueryBuilder<T>,
    deleteQb: QueryBuilder<T>,
    db?: Db
  ): Promise<void>;
}
