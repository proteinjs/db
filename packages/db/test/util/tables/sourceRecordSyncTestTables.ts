import {
  Record as DbRecord,
  SourceRecord,
  StringColumn,
  Table,
  withRecordColumns,
  withSourceRecordColumns,
} from '@proteinjs/db';

/**
 * Fixtures for the source-record sync suites ({@link sourceRecordSyncTests}): a machine-account-
 * shaped mixed table (natural-key adoption + flag-on-removed), a default-policy table (removed =
 * deleted), a misdeclared natural-key table (non-unique column), and the two-generation table
 * pair driving the unique-index duplicate preflight.
 *
 * The `sourceRecordOptions` literals are `as`-cast to the table's options type (not inferred):
 * the cast also compiles against PRE-change `@proteinjs/db`, so the suites can run red-before-
 * green against the old loader (which ignores these options) instead of failing at compile time.
 */

export interface SyncMachineAccount extends SourceRecord {
  email: string;
  displayName?: string | null;
  /** Declared by the loaders ('active') and patched by onSourceRemoved ('deactivated'). */
  status?: string | null;
  /** Runtime-owned: never declared, must survive every boot sync (the credential stand-in). */
  runtimeNote?: string | null;
}

/** The machine-account shape: natural-key adoption by email, removed rows flagged not deleted. */
export class SyncMachineAccountTable extends Table<SyncMachineAccount> {
  name = 'db_test_sync_machine_account';
  columns: Table<SyncMachineAccount>['columns'] = withSourceRecordColumns<SyncMachineAccount>({
    email: new StringColumn('email', {
      unique: { unique: true, indexName: 'db_test_sync_machine_account_email_unique' },
    }),
    displayName: new StringColumn('display_name'),
    status: new StringColumn('status'),
    runtimeNote: new StringColumn('runtime_note'),
  });
  sourceRecordOptions = {
    naturalKey: 'email',
    onSourceRemoved: { update: { status: 'deactivated' } },
  } as Table<SyncMachineAccount>['sourceRecordOptions'];
}

export interface SyncDefaultPolicyRecord extends SourceRecord {
  email: string;
  displayName?: string | null;
}

/** Default options: id-keyed, removed source rows are deleted (today's behavior). */
export class SyncDefaultPolicyTable extends Table<SyncDefaultPolicyRecord> {
  name = 'db_test_sync_default_policy';
  columns: Table<SyncDefaultPolicyRecord>['columns'] = withSourceRecordColumns<SyncDefaultPolicyRecord>({
    email: new StringColumn('email'),
    displayName: new StringColumn('display_name'),
  });
}

export interface DupePreflightRecord extends DbRecord {
  email: string;
}

/** Generation 1: no uniqueness — the table under which duplicate rows accumulate. */
export class DupePreflightTable extends Table<DupePreflightRecord> {
  name = 'db_test_dupe_preflight';
  columns: Table<DupePreflightRecord>['columns'] = withRecordColumns<DupePreflightRecord>({
    email: new StringColumn('email'),
  });
}

/** Generation 2: same table, email now unique — loading it runs the alter-path preflight. */
export class DupePreflightUniqueEmailTable extends Table<DupePreflightRecord> {
  name = 'db_test_dupe_preflight';
  columns: Table<DupePreflightRecord>['columns'] = withRecordColumns<DupePreflightRecord>({
    email: new StringColumn('email', { unique: { unique: true, indexName: 'db_test_dupe_preflight_email_unique' } }),
  });
}

export interface InheritedStampRecord extends SourceRecord {
  email: string;
}

/**
 * The one-owner guard fixture: declares ONLY its own column. The ownership stamps
 * (source_package, source_package_version) must arrive from withSourceRecordColumns — the single
 * owner of the SourceRecord column set — never by per-table declaration. Its physical table is
 * minted by the harness through the normal schema-sync path (TableManager deriving DDL from the
 * type), so the inheritance guard test proves a NEW table gets the stamp columns without
 * declaring them.
 */
export class InheritedStampTable extends Table<InheritedStampRecord> {
  name = 'db_test_sync_inherited_stamp';
  columns: Table<InheritedStampRecord>['columns'] = withSourceRecordColumns<InheritedStampRecord>({
    email: new StringColumn('email'),
  });
}

export interface SyncDerivedNameRecord extends SourceRecord {
  /** Derived by the sync from the DECLARATION (its loader's name) — never typed into the record. */
  name?: string | null;
  email: string;
}

/**
 * The migration-ledger shape: a `name` column the sync fills from the declaration itself
 * (`sourceRecordOptions.fromDeclaration` — the declaring loader's class name), kept on removal
 * like the ledger. The options literal is cast so the suite compiles red-first against a
 * loader that does not yet know the option.
 */
export class SyncDerivedNameTable extends Table<SyncDerivedNameRecord> {
  name = 'db_test_sync_derived_name';
  columns: Table<SyncDerivedNameRecord>['columns'] = withSourceRecordColumns<SyncDerivedNameRecord>({
    name: new StringColumn('name'),
    email: new StringColumn('email'),
  });
  sourceRecordOptions = {
    onSourceRemoved: 'keep',
    fromDeclaration: (declaration: { name: string }) => ({ name: declaration.name }),
  } as Table<SyncDerivedNameRecord>['sourceRecordOptions'];
}

export const sourceRecordSyncTestTables = {
  SyncMachineAccount: new SyncMachineAccountTable() as Table<SyncMachineAccount>,
  SyncDefaultPolicy: new SyncDefaultPolicyTable() as Table<SyncDefaultPolicyRecord>,
  InheritedStamp: new InheritedStampTable() as Table<InheritedStampRecord>,
  SyncDerivedName: new SyncDerivedNameTable() as Table<SyncDerivedNameRecord>,
};
