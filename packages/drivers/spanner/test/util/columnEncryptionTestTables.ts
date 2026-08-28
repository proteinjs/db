import { Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';

/**
 * Tables for the column-encryption suites (`ColumnEncryption.test.ts`,
 * `EncryptedSearch.test.ts`, `EncryptionSortAndUnique.test.ts`,
 * `EncryptionLifecycleWalker.test.ts`, `EncryptionPerf.test.ts`).
 *
 * Defined here rather than in the test files so the reflection build registers them as
 * `Table` loadables — the driver's statement generation and the framework's derived
 * token-table subqueries resolve tables through `tableByName`.
 */

/** Core seam suite: contains + equality + opaque encrypted + plaintext metadata. */
export interface EncNote extends Record {
  scope: string;
  title?: string | null; // encrypted + contains search
  label?: string | null; // encrypted + equality lookup
  body?: string | null; // encrypted, never queried by value
  status?: string | null; // plaintext metadata
}

export class EncNoteTable extends Table<EncNote> {
  name = 'db_test_enc_note';
  columns: Table<EncNote>['columns'] = withRecordColumns<EncNote>({
    scope: new StringColumn('scope', {}, 36),
    title: new StringColumn('title', { encrypted: { searchable: 'contains' } }),
    label: new StringColumn('label', { encrypted: { searchable: 'equality' } }),
    body: new StringColumn('body', { encrypted: {} }, 'MAX'),
    status: new StringColumn('status', { encrypted: false }),
  });
}

/** Search-exactness suite: one contains column beside plaintext metadata. */
export interface EncSearchDoc extends Record {
  scope: string;
  title?: string | null; // encrypted + contains
  name?: string | null; // encrypted + equality
  kind?: string | null; // plaintext metadata
}

export class EncSearchDocTable extends Table<EncSearchDoc> {
  name = 'db_test_enc_search_doc';
  columns: Table<EncSearchDoc>['columns'] = withRecordColumns<EncSearchDoc>({
    scope: new StringColumn('scope', {}, 36),
    title: new StringColumn('title', { encrypted: { searchable: 'contains' } }),
    name: new StringColumn('name', { encrypted: { searchable: 'equality' } }),
    kind: new StringColumn('kind', { encrypted: false }),
  });
}

/** sortKey suite: the declared bounded-reveal native ORDER BY. */
export interface EncSortedItem extends Record {
  scope: string;
  title?: string | null; // encrypted + sortKey(3)
}

export class EncSortedItemTable extends Table<EncSortedItem> {
  name = 'db_test_enc_sorted_item';
  columns: Table<EncSortedItem>['columns'] = withRecordColumns<EncSortedItem>({
    scope: new StringColumn('scope', {}, 36),
    title: new StringColumn('title', { encrypted: { searchable: 'contains', sortKey: { revealPrefix: 3 } } }),
  });
}

/** Uniqueness suite: unique moves onto the equality fingerprint. */
export interface EncUniqueTag extends Record {
  scope: string;
  name?: string | null; // encrypted + equality, unique
}

export class EncUniqueTagTable extends Table<EncUniqueTag> {
  name = 'db_test_enc_unique_tag';
  columns: Table<EncUniqueTag>['columns'] = withRecordColumns<EncUniqueTag>({
    scope: new StringColumn('scope', {}, 36),
    name: new StringColumn('name', { unique: { unique: true }, encrypted: { searchable: 'equality' } }),
  });
}

/** Lifecycle-walker suite: encrypt / retokenize / decrypt / rotate transitions. */
export interface EncWalkRow extends Record {
  scope: string;
  title?: string | null; // encrypted + contains
  body?: string | null; // encrypted, no search
}

export class EncWalkRowTable extends Table<EncWalkRow> {
  name = 'db_test_enc_walk_row';
  columns: Table<EncWalkRow>['columns'] = withRecordColumns<EncWalkRow>({
    scope: new StringColumn('scope', {}, 36),
    title: new StringColumn('title', { encrypted: { searchable: 'contains' } }),
    body: new StringColumn('body', { encrypted: {} }, 'MAX'),
  });
}

/** Perf suite: encrypted-at-rest body vs a plaintext twin, 1k-row reads. */
export interface EncPerfRow extends Record {
  scope: string;
  body?: string | null;
}

export class EncPerfRowTable extends Table<EncPerfRow> {
  name = 'db_test_enc_perf_row';
  columns: Table<EncPerfRow>['columns'] = withRecordColumns<EncPerfRow>({
    scope: new StringColumn('scope', {}, 36),
    body: new StringColumn('body', { encrypted: {} }, 'MAX'),
  });
}

export class PlainPerfRowTable extends Table<EncPerfRow> {
  name = 'db_test_plain_perf_row';
  columns: Table<EncPerfRow>['columns'] = withRecordColumns<EncPerfRow>({
    scope: new StringColumn('scope', {}, 36),
    body: new StringColumn('body', { encrypted: false }, 'MAX'),
  });
}
