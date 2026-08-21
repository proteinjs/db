import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { CustomSerializableObject } from '@proteinjs/serializer';
import { isRecordColumn, Record } from './Record';
import { TableSerializerId } from './serializers/TableSerializer';
import { QueryBuilder } from '@proteinjs/db-query';
import { Identity, TableOperationsAuth } from './auth/TableAuth';
import { Db } from './Db';

export const isTable = (obj: any) => obj.__serializerId === TableSerializerId;

export const getTables = <T extends Record = any>() => SourceRepository.get().objects<Table<T>>('@proteinjs/db/Table');

export const tableByName = (name: string) => {
  const tables = getTables();
  for (const table of tables) {
    if (table.name == name) {
      return table;
    }
  }

  throw new Error(`Unable to find table: ${name}`);
};

export const getColumnPropertyName = (table: Table<any>, columnName: string) => {
  for (const columnPropertyName in table.columns) {
    const column = table.columns[columnPropertyName];
    if (column.name == columnName) {
      return columnPropertyName;
    }
  }

  return null;
};

export const getColumnByName = (table: Table<any>, columnName: string) => {
  for (const columnPropertyName in table.columns) {
    const column = table.columns[columnPropertyName];
    if (column.name == columnName) {
      return column;
    }
  }

  return null;
};

export const addDefaultFieldValues = async (table: Table<any>, record: any, runAsSystem: boolean) => {
  // Get defaultFieldValue for Record columns first
  const columns = Object.keys(table.columns).sort((a, b) => +!isRecordColumn(a) - +!isRecordColumn(b));

  for (const columnPropertyName of columns) {
    const column = (table.columns as any)[columnPropertyName] as Column<any, any>;
    if (
      column.options?.defaultValue &&
      (typeof record[columnPropertyName] === 'undefined' ||
        column.options?.forceDefaultValue === true ||
        (typeof column.options?.forceDefaultValue === 'function' && column.options.forceDefaultValue(runAsSystem)))
    ) {
      record[columnPropertyName] = await column.options.defaultValue(table, record);
    }
  }
};

export const addUpdateFieldValues = async (table: Table<any>, record: any) => {
  for (const columnPropertyName in table.columns) {
    const column = (table.columns as any)[columnPropertyName] as Column<any, any>;
    if (column.options?.updateValue) {
      const value = await column.options.updateValue(table, record);
      if (value !== undefined) {
        record[columnPropertyName] = value;
      }
    }
  }
};

/**
 * primary key is `id`
 */
export abstract class Table<T extends Record> implements Loadable, CustomSerializableObject {
  public __serializerId = TableSerializerId;
  abstract name: string;
  abstract columns: Columns<T>;
  /**
   * `unique: true` creates a UNIQUE index (composite uniqueness lives here; single-column
   * uniqueness can also use `ColumnOptions.unique`). Name unique indexes with a `_unique`
   * suffix — schema metadata classifies unique indexes by that suffix.
   */
  public indexes: { columns: (keyof T)[]; name?: string; unique?: boolean }[] = [];
  /** When records are deleted, delete records having references pointing to deleted records */
  public cascadeDeleteReferences: () => { table: string; referenceColumn: string }[] = () => [];
  /** Options for configuring SourceRecords (see {@link SourceRecordOptions}) */
  public sourceRecordOptions: SourceRecordOptions<T> = {};
  public auth?: {
    db?: TableOperationsAuth;
    service?: TableOperationsAuth;
    /**
     * Columns that can never be WRITTEN through the generic `DbService` RPC path: a service-path
     * insert/update that sets one of these to a non-null value is rejected with a clean
     * `ServiceError` before the operation runs (see `TableServiceAuth`). Server-side code using
     * `Db` directly is unaffected. Use when a table must stay client-writable overall but a
     * column's writes are reserved to server logic — e.g. `chat.parent`, which only
     * `FlowConversation.createConversation` may set.
     */
    serviceProtectedColumns?: (keyof T & string)[];
    ui?: {
      recordTable?: Identity;
      recordForm?: Identity;
    };
  };
}

type ExcludeFunctions<T> = {
  [P in keyof T as T[P] extends Function ? never : P]: T[P];
};

type RequiredProps<T> = {
  [P in keyof ExcludeFunctions<T>]: ExcludeFunctions<T>[P] extends undefined ? never : P;
}[keyof ExcludeFunctions<T>];

type OptionalProps<T> = {
  [P in keyof ExcludeFunctions<T>]: ExcludeFunctions<T>[P] extends undefined ? P : never;
}[keyof ExcludeFunctions<T>];

export type Columns<T> = {
  [P in RequiredProps<T>]: Column<T[P], any>;
} & {
  [P in OptionalProps<T>]?: Column<T[P] | undefined, any>;
};

export type Column<T, Serialized> = {
  name: string;
  /**
   * Use to rename column, will find column with `oldName` and change it to `name`.
   *
   * Note: after name change has happened in prod, oldName can be removed.
   */
  oldName?: string;
  options?: ColumnOptions;
  serialize?: (fieldValue: T | null | undefined) => Promise<Serialized | null | undefined>;
  deserialize?: (serializedFieldValue: Serialized | null, serializedRecord: any) => Promise<T | null | void>;
  beforeDelete?: (
    table: Table<any>,
    columnPropertyName: string,
    records: any[],
    getTable?: (tableName: string) => Table<any>,
    db?: Db
  ) => Promise<void>;
};

export type ColumnOptions = {
  unique?: { unique: boolean; indexName?: string };
  /**
   * The column in the reference table `table` is the primary key of the table (`id` unless otherwise specified in the Table definition)
   *
   * Note: use a migration to drop or change an existing foreign key
   */
  references?: { table: string };
  nullable?: boolean;
  /** Value stored on insert */
  defaultValue?: (table: Table<any>, insertObj: any & Record) => Promise<any>;
  /** If true, the `defaultValue` function will always provide the value and override any existing value */
  forceDefaultValue?: boolean | ((runAsSystem: boolean) => boolean);
  /** Value stored on update */
  updateValue?: (table: Table<any>, updateObj: any) => Promise<any>;
  /**
   * When active, `Db.update` strips this column from update payloads — the stored value can never
   * be rewritten through an update (e.g. a ScopedRecord's `scope`: forced on insert, and without
   * this a client-path update could reassign a row into another user's scope).
   */
  immutable?: boolean | ((runAsSystem: boolean) => boolean);
  /** Add conditions to query; called on every query of this table */
  addToQuery?: (qb: QueryBuilder, runAsSystem: boolean, operation: 'read' | 'write' | 'delete') => Promise<void>;
  onBeforeInsert?: (insertObj: any & Record, runAsSystem: boolean) => Promise<void>;
  /**
   * Called after an id-targeted SINGLE-ROW filtered write (update or delete) on this table matched
   * ZERO rows in a NON-system context. A column that narrows row visibility by capability (e.g.
   * `SharedRecord`'s permission subquery) implements this to turn a silent 0 — which the caller
   * cannot distinguish from a genuine capability denial — into a typed error. Return normally to
   * leave the 0 as a legitimate no-op (row genuinely absent, or value unchanged for a caller who
   * DOES hold the capability); throw (a `RecordAccessError`) to surface the refusal.
   *
   * Scope is deliberately narrow: only single-row id targets fire it, so a legitimate multi-row
   * filtered write that matches nothing is never mis-flagged, and system-context maintenance
   * writes never reach it.
   */
  onZeroRowFilteredWrite?: (
    table: Table<any>,
    id: string,
    operation: 'write' | 'delete',
    runAsSystem: boolean
  ) => Promise<void>;
  ui?: {
    hidden?: boolean;
  };
};

export type SourceRecordOptions<T = any> = {
  /**
   * What the source-record sync does with rows it previously loaded from source
   * (`is_loaded_from_source = true`) whose declaration no longer exists:
   * - `'delete'` (default): delete the rows.
   * - `'keep'`: leave the rows untouched (e.g. the migration ledger — run history outlives the
   *   migration class).
   * - `{ update }`: apply the patch to the removed rows — e.g. a machine-account table flagging
   *   removed accounts `{ update: { status: 'deactivated' } }` instead of deleting them. The
   *   patch is applied only to rows whose fields actually differ (idempotent boots), through
   *   `Db.update`, so table watchers observe the write. Re-declaring the record reverts the
   *   patch via normal drift reversion — removal is reversible in source.
   *
   * Rows never loaded from source are structurally untouchable by every policy: the removed
   * reconcile only ever matches `is_loaded_from_source = true`.
   */
  onSourceRemoved?: 'delete' | 'keep' | { update: Partial<T> };
  /**
   * When set, the sync keys records on this column instead of `id` — matching, adoption, and
   * the removed reconcile all use it. An existing row matched by natural key is ADOPTED in
   * place: it keeps its id (the declared id is used only for fresh inserts — existing ids may
   * be referenced from other tables), gets stamped `is_loaded_from_source = true`, and has its
   * declared fields reverted to source. Drift comparison excludes `id`, so adoption converges.
   *
   * Preconditions, validated at boot by the loader (loud failures):
   * - the column is declared unique (`ColumnOptions.unique` or a single-column unique index in
   *   {@link Table.indexes});
   * - every declaration provides the natural key, and no two declarations share a value.
   */
  naturalKey?: keyof T & string;
  ui?: {
    hideColumns?: boolean;
  };
};
