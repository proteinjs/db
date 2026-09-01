import { isInstanceOf } from '@proteinjs/util';
import { Column, EncryptedColumnConfig, Table } from '../Table';
import { Record, withRecordColumns } from '../Record';
import {
  BinaryColumn,
  BooleanColumn,
  DateColumn,
  DateTimeColumn,
  DecimalColumn,
  DynamicReferenceColumn,
  DynamicReferenceTableNameColumn,
  FloatColumn,
  IntegerColumn,
  ObjectColumn,
  ReferenceArrayColumn,
  ReferenceColumn,
  StringColumn,
  UuidColumn,
} from '../Columns';
import { EncryptedColumnConfigError } from './DbEncryptionConfig';
import { EncryptionDerivedTableRegistry } from './EncryptionDerivedTableRegistry';

/** One search-token row: a keyed fingerprint of one token of one encrypted column value. */
export interface EncryptionSearchToken extends Record {
  recordId: string;
  columnName: string;
  token: string;
}

/**
 * The schema side of column encryption (`ColumnOptions.encrypted`): validation of the
 * declaration, and derivation of the physical schema an encrypted column needs —
 * automatically, at the framework seam, never by callers:
 *
 * - the ciphertext column itself widens to STRING(MAX) (envelopes outgrow declared widths);
 * - `searchable: 'equality'` derives an indexed whole-value fingerprint companion column
 *   (`<column>_enc_eq`); a `unique` declaration on the base column moves onto it (per-owner
 *   value uniqueness — fingerprints are keyed per owner);
 * - `searchable: 'contains'` derives a companion search-token TABLE (`<table>_enc_tok`) —
 *   a plain indexed inverted index, portable across drivers (Spanner's native search
 *   indexes are a named later optimization at the driver layer);
 * - `sortKey: { revealPrefix: N }` derives an ordered-prefix companion column
 *   (`<column>_enc_srt`) for native ORDER BY — the declared bounded reveal.
 *
 * `ensureSchema` is idempotent and runs wherever the physical schema is consulted
 * (TableManager, the record serializer, the query translator).
 */
export class EncryptedColumns {
  private static readonly SCHEMA_APPLIED_MARKER = '__encSchemaApplied';
  private static readonly INTERNAL_COLUMN_MARKER = '__encInternalColumn';

  /** Validate declarations and inject the derived physical schema (idempotent). */
  ensureSchema(table: Table<any>): void {
    if ((table as any)[EncryptedColumns.SCHEMA_APPLIED_MARKER]) {
      return;
    }

    let hasContainsColumns = false;
    for (const prop of Object.keys(table.columns)) {
      const column = (table.columns as any)[prop] as Column<any, any>;
      const config = this.validateDeclaration(table, prop, column);
      if (!config) {
        continue;
      }

      if (typeof (column as any).maxLength !== 'undefined') {
        // Envelopes outgrow the declared plaintext width; the physical column is MAX.
        (column as any).maxLength = 'MAX';
      }

      if (config.searchable === 'equality') {
        this.injectEqualityCompanion(table, prop, column);
      }
      if (config.searchable === 'contains') {
        hasContainsColumns = true;
      }
      if (config.sortKey) {
        this.injectSortCompanion(table, prop, column, config.sortKey.revealPrefix);
      }

      // The column's QUERY-side contract (`Column.queryTransform` — the parallel of the
      // storage-side serialize/deserialize seam), DERIVED from the declaration at this
      // framework seam, never caller-declared. `QueryBuilder.applyColumnTransforms`
      // consults it on every query. Call-time require: the transform pulls the key-store
      // stack, which sits beside Db in the module graph.
      column.queryTransform = (runtime) => {
        const { EncryptedColumnQueryTransform } =
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          require('./EncryptedColumnQueryTransform') as typeof import('./EncryptedColumnQueryTransform');
        return new EncryptedColumnQueryTransform(table, prop, column, config, runtime);
      };
    }

    if (hasContainsColumns) {
      EncryptionDerivedTableRegistry.register(this.tokenTableShape(table));
    }

    // Marked only after full success: a validation throw above must re-validate (and
    // re-throw, loudly) on every subsequent use, never half-apply.
    (table as any)[EncryptedColumns.SCHEMA_APPLIED_MARKER] = true;
  }

  /**
   * The mandatory-declaration gate (`DbEncryptionConfig.requireEncryptedDeclarations`):
   * every text-holding column must declare `encrypted` (`false` or a config object), so no
   * column can be added without deciding, and the encrypted set can never silently drift.
   *
   * The gate is DEFAULT-SUSPECT (the classification principle: ambiguity resolves to the
   * declared side): only column classes that are provably non-text — numbers, booleans,
   * dates, binary, and the identifier/reference family — are exempt. Everything else,
   * including driver-specific classes the core cannot see (e.g. spanner-common's
   * `JsonColumn`, which holds serialized documents), must say `encrypted: false` out loud
   * or be moved to a string-serialized column class to encrypt. Without this inversion a
   * JSON-typed free-text payload would slip past the gate unclassified.
   */
  validateDeclarations(table: Table<any>): void {
    const undeclared: string[] = [];
    for (const prop of Object.keys(table.columns)) {
      const column = (table.columns as any)[prop] as Column<any, any>;
      if (!this.requiresDeclaration(column) || this.isInternalColumn(column)) {
        continue;
      }

      if (typeof column.options?.encrypted === 'undefined') {
        undeclared.push(`${prop} ('${column.name}')`);
      }
    }

    if (undeclared.length > 0) {
      throw new EncryptedColumnConfigError(
        `(${table.name}) Every text-holding column must declare 'encrypted' (false, or a config ` +
          `object such as {} or { searchable: 'contains' }). JSON and other non-string column ` +
          `classes cannot encrypt — declare 'encrypted: false' on them, or move the payload to a ` +
          `string-serialized column class (ObjectColumn) to encrypt. ` +
          `Missing declarations: ${undeclared.join(', ')}`
      );
    }
  }

  /** The `encrypted` config object for a column property, or undefined when not encrypted. */
  configFor(table: Table<any>, prop: string): EncryptedColumnConfig | undefined {
    const column = (table.columns as any)[prop] as Column<any, any> | undefined;
    const encrypted = column?.options?.encrypted;
    return encrypted && typeof encrypted === 'object' ? encrypted : undefined;
  }

  /** Property names of this table's encrypted columns. */
  encryptedProps(table: Table<any>): string[] {
    return Object.keys(table.columns).filter((prop) => !!this.configFor(table, prop));
  }

  /** Property names declared `searchable: 'contains'`. */
  containsProps(table: Table<any>): string[] {
    return this.encryptedProps(table).filter((prop) => this.configFor(table, prop)!.searchable === 'contains');
  }

  /** Does this write payload touch any encrypted column? */
  recordTouchesEncryptedColumns(table: Table<any>, record: any): boolean {
    return this.encryptedProps(table).some((prop) => typeof record[prop] !== 'undefined');
  }

  hasEncryptedColumns(table: Table<any>): boolean {
    return this.encryptedProps(table).length > 0;
  }

  /** The derived search-token table for `table`, or undefined when nothing is `contains`-searchable. */
  tokenTableFor(table: Table<any>): Table<EncryptionSearchToken> | undefined {
    this.ensureSchema(table);
    return EncryptionDerivedTableRegistry.get(this.tokenTableName(table)) as Table<EncryptionSearchToken> | undefined;
  }

  tokenTableName(table: Table<any>): string {
    return `${table.name}_enc_tok`;
  }

  /** Companion property names EQUAL their column names (several seams assume prop == name). */
  eqCompanionProp(table: Table<any>, prop: string): string {
    return `${((table.columns as any)[prop] as { name: string }).name}_enc_eq`;
  }

  sortCompanionProp(table: Table<any>, prop: string): string {
    return `${((table.columns as any)[prop] as { name: string }).name}_enc_srt`;
  }

  /** Framework-derived companion columns are dropped from deserialized records and exempt from declaration checks. */
  isInternalColumn(column: Column<any, any>): boolean {
    return !!(column as any)[EncryptedColumns.INTERNAL_COLUMN_MARKER];
  }

  private validateDeclaration(
    table: Table<any>,
    prop: string,
    column: Column<any, any>
  ): EncryptedColumnConfig | undefined {
    const encrypted = column.options?.encrypted;
    if (typeof encrypted === 'undefined' || encrypted === false) {
      return undefined;
    }

    if (typeof encrypted !== 'object') {
      throw new EncryptedColumnConfigError(
        `(${table.name}.${prop}) 'encrypted' must be false or a config object ` +
          `(e.g. {}, { searchable: 'contains' }); got: ${JSON.stringify(encrypted)}`
      );
    }

    if (!this.isTextColumn(column)) {
      throw new EncryptedColumnConfigError(
        `(${table.name}.${prop}) 'encrypted' is only supported on text columns (StringColumn family). ` +
          `Identifier and reference columns are metadata by construction; JSON-typed columns must use a ` +
          `string-serialized column type to encrypt.`
      );
    }

    if (encrypted.searchable && encrypted.searchable !== 'contains' && encrypted.searchable !== 'equality') {
      throw new EncryptedColumnConfigError(
        `(${table.name}.${prop}) encrypted.searchable must be 'contains' or 'equality'; ` +
          `got: ${JSON.stringify(encrypted.searchable)}`
      );
    }

    if ((encrypted.searchable || encrypted.sortKey) && isInstanceOf(column, ObjectColumn)) {
      throw new EncryptedColumnConfigError(
        `(${table.name}.${prop}) encrypted.searchable / encrypted.sortKey require a plain string column ` +
          `(the search and sort derivatives cover the value's text, not its serialization). ` +
          `Object/array columns may declare encrypted: {} (encrypted, never queried by value).`
      );
    }

    if (encrypted.sortKey) {
      const revealPrefix = encrypted.sortKey.revealPrefix;
      if (!Number.isInteger(revealPrefix) || revealPrefix < 1) {
        throw new EncryptedColumnConfigError(
          `(${table.name}.${prop}) encrypted.sortKey.revealPrefix must be a positive integer ` +
            `(the number of leading characters whose order the sort column reveals); ` +
            `got: ${JSON.stringify(revealPrefix)}`
        );
      }
    }

    if (column.options?.unique?.unique && encrypted.searchable !== 'equality') {
      throw new EncryptedColumnConfigError(
        `(${table.name}.${prop}) a unique constraint on an encrypted column requires ` +
          `encrypted: { searchable: 'equality' } — uniqueness is enforced through a unique index on ` +
          `the whole-value fingerprint (ciphertext is never equal, so a unique index on it cannot bite).`
      );
    }

    return encrypted;
  }

  private injectEqualityCompanion(table: Table<any>, prop: string, column: Column<any, any>): void {
    const companionProp = `${column.name}_enc_eq`;
    const baseUnique = column.options?.unique?.unique === true;
    const companion = new StringColumn(
      `${column.name}_enc_eq`,
      {
        nullable: true,
        ...(baseUnique ? { unique: { unique: true, indexName: `${table.name}_${column.name}_enc_eq_unique` } } : {}),
        ui: { hidden: true },
      },
      64
    );
    this.injectCompanionColumn(table, companionProp, companion);
    if (baseUnique) {
      // Uniqueness moves to the fingerprint column (see validateDeclaration).
      delete column.options!.unique;
    } else {
      table.indexes.push({
        columns: [companionProp],
        name: `${table.name}_${column.name}_enc_eq_idx`,
      });
    }
  }

  private injectSortCompanion(table: Table<any>, prop: string, column: Column<any, any>, revealPrefix: number): void {
    const companion = new StringColumn(
      `${column.name}_enc_srt`,
      { nullable: true, ui: { hidden: true } },
      Math.max(revealPrefix, 1)
    );
    this.injectCompanionColumn(table, `${column.name}_enc_srt`, companion);
  }

  private injectCompanionColumn(table: Table<any>, companionProp: string, companion: Column<any, any>): void {
    if ((table.columns as any)[companionProp] && !this.isInternalColumn((table.columns as any)[companionProp])) {
      throw new EncryptedColumnConfigError(
        `(${table.name}) Column property '${companionProp}' collides with a framework-derived ` +
          `encryption companion column. Rename the declared column.`
      );
    }

    (companion as any)[EncryptedColumns.INTERNAL_COLUMN_MARKER] = true;
    (table.columns as any)[companionProp] = companion;
  }

  /**
   * The token table's SHAPE for `table`, independent of registration — the lifecycle
   * walker's decrypt-out sweep needs it after the config stopped declaring any
   * `searchable: 'contains'` column (when `tokenTableFor` no longer resolves).
   */
  tokenTableShape(table: Table<any>): Table<EncryptionSearchToken> {
    const tokenTableName = this.tokenTableName(table);
    const tokenTable = new (class extends Table<EncryptionSearchToken> {
      public name = tokenTableName;
      public columns: Table<EncryptionSearchToken>['columns'] = withRecordColumns<EncryptionSearchToken>({
        recordId: new StringColumn('record_id', { nullable: false, encrypted: false }, 36),
        columnName: new StringColumn('column_name', { nullable: false, encrypted: false }, 128),
        token: new StringColumn('token', { nullable: false, encrypted: false }, 64), // keyed fingerprints — irreversible without the index key
      });
      public indexes: { columns: (keyof EncryptionSearchToken)[]; name?: string; unique?: boolean }[] = [
        { columns: ['token', 'columnName'], name: `${tokenTableName}_cover_idx` },
        { columns: ['recordId'], name: `${tokenTableName}_record_idx` },
      ];
      // No auth block: default-deny for non-system callers; only framework system paths
      // (EncryptionTokenMaintenance, the query translator's subqueries) touch token rows.
    })();
    return tokenTable;
  }

  private isTextColumn(column: Column<any, any>): boolean {
    if (!isInstanceOf(column, StringColumn)) {
      return false;
    }

    return !this.isIdentifierColumn(column);
  }

  /**
   * Whether the declaration gate applies (see `validateDeclarations`): every column that is
   * not provably non-text. Encryptability stays narrower — only the StringColumn family
   * encrypts (`isTextColumn`) — but the GATE must also see JSON/custom classes, or their
   * free text would never have to declare a side.
   */
  private requiresDeclaration(column: Column<any, any>): boolean {
    if (this.isTextColumn(column)) {
      return true;
    }

    const exempt =
      isInstanceOf(column, IntegerColumn) ||
      isInstanceOf(column, FloatColumn) ||
      isInstanceOf(column, DecimalColumn) ||
      isInstanceOf(column, BooleanColumn) ||
      isInstanceOf(column, DateColumn) ||
      isInstanceOf(column, DateTimeColumn) ||
      isInstanceOf(column, BinaryColumn) ||
      this.isIdentifierColumn(column);
    return !exempt;
  }

  private isIdentifierColumn(column: Column<any, any>): boolean {
    return (
      isInstanceOf(column, UuidColumn) ||
      isInstanceOf(column, ReferenceColumn) ||
      isInstanceOf(column, ReferenceArrayColumn) ||
      isInstanceOf(column, DynamicReferenceColumn) ||
      isInstanceOf(column, DynamicReferenceTableNameColumn)
    );
  }
}
