import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { CustomSerializableObject } from '@proteinjs/serializer';
import { isRecordColumn, Record } from './Record';
import { TableSerializerId } from './serializers/TableSerializer';
import { ColumnQueryTransform, QueryBuilder, SortCriteria } from '@proteinjs/db-query';
import { Identity, TableOperationsAuth } from './auth/TableAuth';
import { Db } from './Db';
import { EncryptionDerivedTableRegistry } from './encryption/EncryptionDerivedTableRegistry';

export const isTable = (obj: any) => obj.__serializerId === TableSerializerId;

export const getTables = <T extends Record = any>() => SourceRepository.get().objects<Table<T>>('@proteinjs/db/Table');

export const tableByName = (name: string) => {
  const tables = getTables();
  for (const table of tables) {
    if (table.name == name) {
      return ensureEncryptionSchema(table);
    }
  }

  // Framework-DERIVED tables (search-token tables beside encrypted columns) are synthesized
  // from column config rather than declared in source, so the reflection registry never
  // sees them (see EncryptionDerivedTableRegistry — a runtime-cycle-free, type-only import).
  const derivedTable = EncryptionDerivedTableRegistry.get(name);
  if (derivedTable) {
    return derivedTable;
  }

  throw new Error(`Unable to find table: ${name}`);
};

/**
 * Table instances are constructed ad hoc all over consumer code, and the encryption-derived
 * physical schema (companion columns — see `EncryptedColumns.ensureSchema`) is injected
 * per-instance at the seams that use an instance. Name-based resolution is one of those
 * seams: statement generation and driver column-type lookups resolve the REGISTRY's
 * instance through here, which must carry the same derived columns as the instance the
 * caller handed the Db. Idempotent (marker-checked); a call-time require keeps the module
 * graph acyclic at load time.
 */
const ensureEncryptionSchema = (table: Table<any>): Table<any> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EncryptedColumns } =
    require('./encryption/EncryptedColumns') as typeof import('./encryption/EncryptedColumns');
  new EncryptedColumns().ensureSchema(table);
  return table;
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
  /**
   * Presentation the table declares for the GENERIC record surfaces (@proteinjs/db-ui) — the
   * framework renders what tables declare; per-table display choices never hard-code into the
   * generic components. Distinct from `auth.ui`, which gates WHO may see those surfaces.
   */
  public ui?: {
    recordTable?: {
      /**
       * The columns rendered as the record table's row columns, in this order. `created` and
       * `updated` are appended automatically (the record family's shared face) unless already
       * listed. Undeclared tables get the meaningful-data default pick
       * (db-ui `defaultRecordTableColumns`). Declare when the default pick misses a column a
       * human scans for (e.g. the migration ledger's `duration`) or surfaces one that has no
       * business in a row scan (e.g. an invite's redeemable `token` — row hygiene; the record
       * form still carries the full record).
       */
      columns?: (keyof T & string)[];
      /**
       * The record table's default ordering (the sort its default loader applies before any
       * user interaction). Undeclared tables keep the generic `updated` descending. Declare
       * when the rows have a natural reading order the shared face can't know — e.g. the
       * migration ledger reads most-recently-run first, never-run rows last.
       */
      sort?: SortCriteria<T>[];
    };
  };
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

/**
 * What a column's query transform runs WITH: the current operation's authority and its
 * driver/transaction-riding query runners. Supplied by `Db` per operation
 * (`Db.addColumnQueries`), so a transform's own reads behave like part of the query that
 * carried them.
 */
export interface ColumnQueryRuntime {
  runAsSystem: boolean;
  /** Query with the CALLER's authority (auth + column queries apply). */
  query: (table: Table<any>, qb: QueryBuilder<any>) => Promise<any[]>;
  /** System-authority query — for framework-derived tables that are default-deny to callers. */
  systemQuery: (table: Table<any>, qb: QueryBuilder<any>) => Promise<any[]>;
}

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
  /**
   * The column's QUERY-side contract, paralleling `serialize`/`deserialize` on the storage
   * side: how uses of this column in a query (conditions, ORDER BY, aggregation, GROUP BY)
   * translate into uses of what the database actually stores and indexes for it — see
   * `ColumnQueryTransform` (@proteinjs/db-query). Applied by
   * `QueryBuilder.applyColumnTransforms` on every query, through
   * `TableQueryTransformProvider`.
   *
   * A factory rather than a bare transform: translation may consult derived index state
   * (e.g. an encrypted column's token table), so a transform is built per operation with
   * the operation's `ColumnQueryRuntime` — its driver-riding query runners and authority.
   * Derived by the framework for encrypted columns (`EncryptedColumns.ensureSchema`);
   * any column may supply one.
   */
  queryTransform?: (runtime: ColumnQueryRuntime) => ColumnQueryTransform;
  beforeDelete?: (
    table: Table<any>,
    columnPropertyName: string,
    records: any[],
    getTable?: (tableName: string) => Table<any>,
    db?: Db
  ) => Promise<void>;
};

/**
 * Capabilities of an encrypted column. Nested INSIDE the `encrypted` declaration on purpose:
 * `searchable` and `sortKey` only mean anything on an encrypted column (a plaintext column
 * is inherently searchable and sortable through normal SQL), so the invalid state — a
 * search/sort capability declared without encryption — is unrepresentable.
 */
export type EncryptedColumnConfig = {
  /**
   * Index the value for native querying over ciphertext (derived automatically at the
   * database layer — see `EncryptedColumns`):
   * - `'contains'` — word + trigram search tokens, keyed-fingerprinted per owner, serving
   *   the LIKE contains/prefix family with exact results (candidate cover + decrypt-verify).
   * - `'equality'` — one whole-value fingerprint companion column serving `=` / `IN` /
   *   get-by-value as a single indexed lookup (and value uniqueness, per owner).
   * Encrypted columns that are never queried by value declare neither and carry no
   * derivatives — the default.
   */
  searchable?: 'contains' | 'equality';
  /**
   * Native ORDER BY at any scale through a DECLARED bounded reveal: an ordered
   * representation of the value's first `revealPrefix` characters (normalized) is stored
   * beside the ciphertext and the database sorts on it. The leak, stated plainly: raw
   * database access can see each value's first `revealPrefix` characters — nothing else.
   * A conscious, schema-author-declared tradeoff; never the default. Rows sharing a prefix
   * tie-break app-side within the returned page.
   */
  sortKey?: { revealPrefix: number };
};

export type ColumnOptions = {
  unique?: { unique: boolean; indexName?: string };
  /**
   * Whether this column's values are stored encrypted (AES-256-GCM under per-owner data
   * keys wrapped by the deployment's master key — see `DbEncryptionConfig`). The value is
   * either `false` (plaintext — said out loud) or a config object:
   *
   * ```ts
   * encrypted: false                             // plaintext (explicit)
   * encrypted: {}                                // encrypted, never queried by value
   * encrypted: { searchable: 'contains' }        // + indexed contains/prefix search
   * encrypted: { searchable: 'equality' }        // + indexed exact-match lookup
   * encrypted: { sortKey: { revealPrefix: 3 } }  // + native ORDER BY via a declared bounded reveal
   * ```
   *
   * Everything downstream — the transparent encrypt/decrypt seam, companion index
   * derivation, query translation, loud contract rejections, lifecycle backfills — is
   * derived automatically at the database layer; callers never write an encrypt or decrypt
   * call. Query shapes outside the contract are rejected at query-build time
   * (`EncryptionQueryTranslator`).
   *
   * When `DbEncryptionConfig.requireEncryptedDeclarations` is on, every text-holding
   * column MUST carry this declaration — registration fails loudly otherwise.
   */
  encrypted?: false | EncryptedColumnConfig;
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
  /**
   * Called before the row's insert DML runs, after defaults and before-insert table watchers.
   * Runs where inserts execute (`Db.insert` — the server; a browser only ever proxies or queues),
   * so guards here hold regardless of where column DEFAULTS were applied (the client `Transaction`
   * path applies them in the browser). Throw to refuse the insert.
   */
  onBeforeInsert?: (table: Table<any>, insertObj: any & Record, runAsSystem: boolean) => Promise<void>;
  /**
   * Called after the row's insert DML SUCCEEDS, before after-insert table watchers. The seam for
   * side-effect writes that are part of the row's birth (e.g. `SharedRecord`'s platform-conferred
   * owner grant): running server-side keeps column defaults pure enough for driverless client
   * contexts, and running after the DML means a failed insert (duplicate id, refused guard) can
   * never leave the side effect behind.
   */
  onAfterInsert?: (table: Table<any>, insertObj: any & Record, runAsSystem: boolean) => Promise<void>;
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
    /**
     * The column's display label on the generic record surfaces (table header, form field,
     * phone card label). Undeclared, the surfaces humanize the property name (`startTime` →
     * "Start time"); declare when the property name is not how a human reads the value
     * (the migration ledger's `startTime` reads as "Ran at"). One owner: both surfaces derive
     * from it, so a label can never differ between the table and the form.
     */
    label?: string;
    /**
     * Which section of the record form this column belongs to. The form derives a sane
     * section from the column's type and name (identity strings up top, long text and
     * structured values under Content, everything else under Details, server-managed meta
     * under System); this hint overrides the derivation. Known values map to the canonical
     * sections ('identity' | 'content' | 'details' | 'system'); any other string becomes its
     * own titled section, ordered after Details.
     */
    formGroup?: 'identity' | 'content' | 'details' | 'system' | (string & {});
  };
};

/**
 * The identity of one source-record declaration (a `SourceRecordLoader` in a build): the
 * package that owns it, the reflection qualified name, and the declaration's own name — the
 * loader's class name (or variable name), the part of the qualified name after the package.
 * See `SourceRecordLoaderDeclaration` for the identity paired with the loader itself.
 */
export type SourceRecordDeclarationIdentity = {
  source: string;
  qualifiedName: string;
  name: string;
};

export type SourceRecordOptions<T = any> = {
  /**
   * Fields the sync derives from the DECLARATION ITSELF rather than from its record — for
   * tables whose rows carry facts about their declaration: the migration ledger's `name` is
   * the declaring loader's class name, which no migration author should have to type twice.
   * Called once per declaration per boot; the result is merged over the declared record
   * BEFORE the drift comparison, so the derivation owns those fields (a value typed into the
   * record does not survive it), an existing row missing a derived field is backfilled by the
   * next boot exactly once, and an unchanged derivation never rewrites a row.
   */
  fromDeclaration?: (declaration: SourceRecordDeclarationIdentity) => Partial<T>;
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
   * THE SOFT-REMOVAL CONTRACT: a source-record table that soft-removes (keeps rows on removal —
   * the `{ update }` policy) must adopt its soft-removed rows on re-declaration and re-derive
   * their state from the declaration. Under the default (delete) lifecycle, re-declaration is a
   * plain re-insert and naturally idempotent; a kept row instead still holds the declared id, so
   * a re-declaration whose natural key no longer matches it (renamed while removed) would INSERT
   * into a primary-key collision and fail the boot. The sync therefore widens adoption for these
   * tables: a declaration whose natural key matches nothing re-claims the soft-removed row
   * holding its declared id (same owning package only), reactivating it by re-deriving every
   * declared field — declaration is the source of truth, so no removed-era state (grants,
   * status, natural key) survives re-adoption, while runtime-owned fields the declaration never
   * emits are preserved. Any future soft-removal table inherits this requirement; machine
   * accounts (the `@proteinjs/user` user table) are the first implementer.
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
