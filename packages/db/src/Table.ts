import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { CustomSerializableObject } from '@proteinjs/serializer';
import { Record } from './Record';
import { TableSerializerId } from './serializers/TableSerializer';
import { QueryBuilder } from '@proteinjs/db-query';
import { Identity, TableOperationsAuth } from './auth/TableAuth';

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

/**
 * primary key is `id`
 */
export abstract class Table<T extends Record> implements Loadable, CustomSerializableObject {
  public __serializerId = TableSerializerId;
  abstract name: string;
  abstract columns: Columns<T>;
  public indexes: { columns: (keyof T)[]; name?: string }[] = [];
  /** When records are deleted, delete records having references pointing to deleted records */
  public cascadeDeleteReferences: () => { table: string; referenceColumn: string }[] = () => [];
  /**
   * Options for configuring SourceRecords
   * @param doNotDeleteSourceRecordsFromDb if true, the SourceRecordLoader will not delete source records from the db if they no longer exist on the file system
   */
  public sourceRecordOptions: SourceRecordOptions = {
    doNotDeleteSourceRecordsFromDb: false,
  };
  public auth?: {
    db?: TableOperationsAuth;
    service?: TableOperationsAuth;
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
  serialize?: (fieldValue: T | undefined) => Promise<Serialized | undefined>;
  deserialize?: (serializedFieldValue: Serialized) => Promise<T | void>;
  beforeDelete?: (table: Table<any>, columnPropertyName: string, records: any[]) => Promise<void>;
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
  defaultValue?: (insertObj: any) => Promise<any>;
  /** Value stored on update */
  updateValue?: (updateObj: any) => Promise<any>;
  /** Add conditions to query; called on every query of this table */
  addToQuery?: (qb: QueryBuilder, runAsSystem: boolean) => Promise<void>;
  ui?: {
    hidden?: boolean;
  };
};

export type SourceRecordOptions = {
  doNotDeleteSourceRecordsFromDb?: boolean;
  ui?: {
    hideColumns?: boolean;
  };
};
