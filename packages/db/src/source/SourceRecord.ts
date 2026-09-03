import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { Columns, SourceRecordDeclarationIdentity, Table, getTables } from '../Table';
import { Record as DbRecord, withRecordColumns } from '../Record';
import { BooleanColumn, StringColumn } from '../Columns';

/**
 * A source record declaration paired with its owning source: the package that compiled the
 * declaration into this build (from the declaration's reflection qualified name). The source is
 * the ownership grain of the sync — {@link SourceRecordLoader} stamps it on every row it writes
 * and prunes only within it, so servers running different builds against one shared database
 * never delete each other's rows.
 */
export type SourceRecordLoaderDeclaration<T extends SourceRecord = SourceRecord> = SourceRecordDeclarationIdentity & {
  loader: SourceRecordLoader<T>;
};

export const getSourceRecordLoaders = <T extends SourceRecord = SourceRecord>(): SourceRecordLoaderDeclaration<T>[] =>
  SourceRepository.get()
    .objectsWithNames<SourceRecordLoader<T>>('@proteinjs/db/SourceRecordLoader')
    .map(({ packageName, qualifiedName, object }) => ({
      source: packageName,
      qualifiedName,
      name: declarationName(qualifiedName, packageName),
      loader: object,
    }));

/**
 * The declaration's own name from its reflection qualified name (`<package>/<name>`): the
 * loader's class name for a class declaration, the variable name for a variable one.
 */
const declarationName = (qualifiedName: string, packageName: string) =>
  qualifiedName.startsWith(`${packageName}/`)
    ? qualifiedName.slice(packageName.length + 1)
    : qualifiedName.slice(qualifiedName.lastIndexOf('/') + 1);

export function getSourceRecordTables() {
  const tables = getTables();
  const sourceRecordTables: Table<any>[] = [];
  for (const table of tables) {
    if (isSourceRecordTable(table)) {
      sourceRecordTables.push(table);
    }
  }

  return sourceRecordTables;
}

export function isSourceRecordTable(table: Table<any>) {
  for (const columnPropertyName in table.columns) {
    const column = table.columns[columnPropertyName];
    if (column.name == getSourceRecordColumns().isLoadedFromSource.name) {
      return true;
    }
  }

  return false;
}

export interface SourceRecord extends DbRecord {
  isLoadedFromSource?: boolean;
  /**
   * The package whose declaration owns this row (the declaring loader's package, from its
   * reflection qualified name). Stamped by {@link SourceRecordLoader} on every row it writes;
   * the removed-reconcile prunes only rows whose `sourcePackage` matches a package the running
   * build actually declares from — so a build never deletes rows owned by a package it does not
   * carry (e.g. another server's types on a shared database). Rows written before this column
   * existed carry NULL until their owning package's next boot adopts and stamps them.
   */
  sourcePackage?: string;
  /**
   * The declaring package's version at the time this row was last stamped (from the package's
   * own package.json, resolved at runtime). This is the ordering WITHIN a package that makes
   * version skew safe on a shared database: a boot never prunes, flags, or rewrites a row stamped
   * by a strictly NEWER version of the same package, so an older build cannot delete the types a
   * newer build added or churn the ones it redefined. NULL (legacy rows, or builds whose package
   * version could not be resolved) carries no ordering and keeps the last-writer-wins semantics.
   */
  sourcePackageVersion?: string;
}

const getSourceRecordColumns = (hideFromUi = true) => {
  return {
    isLoadedFromSource: new BooleanColumn('is_loaded_from_source', { ui: { hidden: hideFromUi } }),
    sourcePackage: new StringColumn('source_package', { encrypted: false, ui: { hidden: hideFromUi } }), // system package vocabulary
    sourcePackageVersion: new StringColumn('source_package_version', { encrypted: false, ui: { hidden: hideFromUi } }),
  };
};

/**
 * Wrapper function to add default Record and SourceRecord columns to your table's columns.
 *
 * Note: using this requires an explicit dependency on moment@2.29.4 in your package (since transient dependencies are brittle by typescript's standards)
 *
 * @param columns your columns
 * @param hideFromUi if true, source record columns are hidden from RecordTable and RecordForm
 * @returns recordColumns & sourceRecordColumns & your columns
 */
export function withSourceRecordColumns<T extends SourceRecord>(
  columns: Columns<Omit<T, keyof SourceRecord>>,
  hideFromUi?: boolean
): Columns<SourceRecord> & Columns<Omit<T, keyof SourceRecord>> {
  return Object.assign(
    Object.assign({}, getSourceRecordColumns(hideFromUi)),
    withRecordColumns<DbRecord>(columns) as any
  );
}

type InferRecordFromTable<T> = T extends Table<infer R> ? R : never;
type InferRecordWithoutTimestamps<T> = Omit<InferRecordFromTable<T>, 'created' | 'updated'>;
type RequiredProperties<T> = Pick<
  T,
  {
    [K in keyof T]: T extends Record<K, T[K]> ? K : never;
  }[keyof T]
>;
type OptionalProperties<T> = Pick<
  T,
  {
    [K in keyof T]: T extends Record<K, T[K]> ? never : K;
  }[keyof T]
>;

/**
 * Use this to load a record from source into the db.
 *
 * On Db.init, the record will be inserted if it doesn't exist, and updated if it does exist to mirror what is in source.
 *
 * If the SourceRecordLoader is deleted from source, the record will be deleted from the db on server startup (per the
 * table's `onSourceRemoved` policy) — by the next boot of a build that still carries the declaring package at its
 * version or newer. Ownership is per package: a boot only reconciles rows owned by packages it carries, and never
 * rows a newer version of the same package stamped; a package removed from every build leaves its rows behind.
 * This will also be the behavior if id is changed - the record with the old id will be deleted.
 */
export interface SourceRecordLoader<T extends SourceRecord> extends Loadable {
  table: Table<T>;
  record: {
    [P in keyof RequiredProperties<InferRecordWithoutTimestamps<Table<T>>>]: RequiredProperties<
      InferRecordWithoutTimestamps<Table<T>>
    >[P];
  } & {
    [P in keyof OptionalProperties<InferRecordWithoutTimestamps<Table<T>>>]?: OptionalProperties<
      InferRecordWithoutTimestamps<Table<T>>
    >[P];
  };
}
