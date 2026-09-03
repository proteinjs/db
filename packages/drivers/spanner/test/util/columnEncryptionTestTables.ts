import {
  ALL_STRINGS_CONTENT,
  ID_SKELETON_ENTRIES,
  LeafPathPolicy,
  LeafPolicy,
  LeafPolicySource,
  Record,
  StringColumn,
  Table,
  WHOLE_VALUE_CONTENT,
  withRecordColumns,
} from '@proteinjs/db';
import { JsonColumn } from '@proteinjs/db-spanner-common';

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

/**
 * Leaf-encryption suite (`LeafEncryption.test.ts`): JSON documents encrypted per content leaf.
 * `doc` resolves its policy PER ROW from the plaintext `kind` discriminator (the thought
 * `type` shape): kind `trip` declares `state`/`start` as facts (metadata, filterable), anything
 * else gets the default (every string content, `$.type` a platform key). `sources` is the
 * ids-skeleton array policy; `blob` is one whole-value envelope.
 */
export interface EncLeafDoc extends Record {
  scope: string;
  kind?: string | null;
  doc?: any;
  sources?: any;
  blob?: any;
}

const LEAF_DOC_DEFAULT_POLICY: LeafPolicy = new LeafPathPolicy({
  metadata: ['$.type'],
  strings: 'content',
  nonStrings: 'metadata',
});
const LEAF_DOC_TRIP_POLICY: LeafPolicy = new LeafPathPolicy({
  metadata: ['$.type', '$.state', '$.start'],
  strings: 'content',
  nonStrings: 'metadata',
});

/** The per-row resolver — the shape a domain layer (thought-common) supplies for its typed documents. */
export const encLeafDocPolicySource: LeafPolicySource = {
  dependsOn: ['kind'],
  resolve: (row) => (row?.kind === 'trip' ? LEAF_DOC_TRIP_POLICY : LEAF_DOC_DEFAULT_POLICY),
  isAlwaysMetadata: (path) => path === '$.type',
};

export class EncLeafDocTable extends Table<EncLeafDoc> {
  name = 'db_test_enc_leaf_doc';
  columns: Table<EncLeafDoc>['columns'] = withRecordColumns<EncLeafDoc>({
    scope: new StringColumn('scope', {}, 36),
    kind: new StringColumn('kind', { encrypted: false }),
    doc: new JsonColumn('doc', { nullable: true, encrypted: { leaves: encLeafDocPolicySource } }),
    sources: new JsonColumn('sources', { nullable: true, encrypted: { leaves: ID_SKELETON_ENTRIES } }),
    blob: new JsonColumn('blob', { nullable: true, encrypted: { leaves: WHOLE_VALUE_CONTENT } }),
  });
}

void ALL_STRINGS_CONTENT;
