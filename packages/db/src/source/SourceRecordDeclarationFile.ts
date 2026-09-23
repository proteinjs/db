import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { SourceRecordDeclarationIdentity, Table } from '../Table';
import { SourceRecord } from './SourceRecord';

/**
 * A declaration FILE as a declaration source, beside code-declared records: point a table at
 * the document `source-records pull` wrote and every row in it is declared for the table by
 * the package that carries this loadable (the ownership grain of the sync — see
 * {@link SourceRecordLoader}). The path is absolute at runtime: resolve it from the module
 * that ships the file (server-side code only — a browser bundle has no files to read).
 *
 * The table must declare `sourceRecordOptions.declarationColumns`; a file carrying a column
 * outside them, a different table, or a different key is refused at load (the boot fails
 * loudly) — see {@link SourceRecordDeclarationDocument.toRecords}.
 */
export interface SourceRecordDeclarationFile<T extends SourceRecord = SourceRecord> extends Loadable {
  table: Table<T>;
  /** Absolute path to the declaration document. */
  path: string;
}

export type SourceRecordDeclarationFileDeclaration<T extends SourceRecord = SourceRecord> =
  SourceRecordDeclarationIdentity & {
    declarationFile: SourceRecordDeclarationFile<T>;
  };

export const getSourceRecordDeclarationFiles = <
  T extends SourceRecord = SourceRecord,
>(): SourceRecordDeclarationFileDeclaration<T>[] =>
  SourceRepository.get()
    .objectsWithNames<SourceRecordDeclarationFile<T>>('@proteinjs/db/SourceRecordDeclarationFile')
    .map(({ packageName, qualifiedName, object }) => ({
      source: packageName,
      qualifiedName,
      name: qualifiedName.startsWith(`${packageName}/`)
        ? qualifiedName.slice(packageName.length + 1)
        : qualifiedName.slice(qualifiedName.lastIndexOf('/') + 1),
      declarationFile: object,
    }));
