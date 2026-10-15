import type { Table } from '../Table';
import type { SerializedRecord } from '../Record';
import { EncryptedColumnConfigError, getDbEncryptionConfig } from './DbEncryptionConfig';
import { EncryptedColumns } from './EncryptedColumns';
import { EncryptionEnvelope } from './EncryptionEnvelope';
import { DataKeyMaterial, DataKeyStore } from './DataKeyStore';
import { SearchTokenizer } from './SearchTokenizer';

/** Who a row being written belongs to — the data key its values encrypt under. */
export type EncryptionWriteContext = { keyOwner: string };

/** A stored cell holding a ciphertext envelope, and the key the envelope names. */
type EnvelopeCell = { columnName: string; owner: string; version: number };

/**
 * The transparent encrypt/decrypt seam, invoked by `RecordSerializer` on every write's
 * serialize and every read's deserialize — the same per-column hook layer every caller
 * already passes through, so services, watchers, migrations, and queued client
 * transactions get encryption without knowing it exists.
 *
 * - Serialize: after the columns' own `serialize` steps, values of encrypted columns are
 *   replaced with self-describing envelopes (`EncryptionEnvelope`), and the searchable /
 *   sort companions are written beside them in the same statement.
 * - Deserialize: before the columns' own `deserialize` steps, envelope values are decrypted
 *   (the envelope names its key — owner + version — so no context is needed) and
 *   framework-derived companion columns are dropped. A non-envelope value in an encrypted
 *   column passes through unchanged — the online-adoption transition: rows written before
 *   the encrypt backfill stay readable while the walker converges them.
 *
 * Server-only: this seam executes where the database driver runs. Browser code proxies
 * through `DbService` and receives decrypted values over the authenticated service.
 */
export class EncryptionRecordHooks {
  private encryptedColumns = new EncryptedColumns();
  private envelope = new EncryptionEnvelope();
  private tokenizer = new SearchTokenizer();
  private internalNames?: { table: Table<any>; names: Set<string> };

  /** Encrypt encrypted-column values in `serialized` (column-name-keyed) and add companions. */
  async onSerialize(table: Table<any>, serialized: SerializedRecord, context?: EncryptionWriteContext): Promise<void> {
    this.encryptedColumns.ensureSchema(table);
    const touchedProps = this.encryptedColumns
      .encryptedProps(table)
      .filter((prop) => ((table.columns as any)[prop] as { name: string }).name in serialized);
    if (touchedProps.length === 0) {
      return;
    }

    this.assertServerSide();
    let writeKey: DataKeyMaterial | undefined;
    for (const prop of touchedProps) {
      const column = (table.columns as any)[prop];
      const config = this.encryptedColumns.configFor(table, prop)!;
      const value = serialized[column.name];
      if (value === null) {
        // Null stays null (IS NULL queries keep working); companions null out with it.
        if (config.searchable === 'equality') {
          serialized[`${column.name}_enc_eq`] = null;
        }
        if (config.sortKey) {
          serialized[`${column.name}_enc_srt`] = null;
        }
        continue;
      }

      if (typeof value !== 'string') {
        throw new EncryptedColumnConfigError(
          `(${table.name}.${prop}) encrypted columns must serialize to a string; ` +
            `got ${typeof value}. Declare 'encrypted' on a StringColumn-family column.`
        );
      }

      if (!writeKey) {
        if (!context?.keyOwner) {
          throw new EncryptedColumnConfigError(
            `(${table.name}) A write touches encrypted column '${prop}' but no key owner was ` +
              `resolved. Writes to encrypted columns must resolve the row's scope owner ` +
              `(the row's 'scope' value, or DbEncryptionConfig.resolveKeyOwner).`
          );
        }
        writeKey = await new DataKeyStore().getWriteKey(context.keyOwner);
      }

      serialized[column.name] = this.envelope.encrypt(value, writeKey);
      if (config.searchable === 'equality') {
        serialized[`${column.name}_enc_eq`] = this.tokenizer.equalityFingerprint(value, writeKey.indexKey);
      }
      if (config.sortKey) {
        serialized[`${column.name}_enc_srt`] = this.tokenizer.sortPrefix(value, config.sortKey.revealPrefix);
      }
    }
  }

  /**
   * `serializedRecord` with framework companion columns dropped and every envelope value
   * decrypted (any column — self-describing ciphertext also covers the decrypt-out transition,
   * where the config no longer marks the column). Answers directly — the row itself when
   * nothing drops or decrypts, else a copy — unless an envelope must be decrypted: its key is
   * read asynchronously, so the copy settles through a promise.
   */
  onDeserialize(table: Table<any>, serializedRecord: SerializedRecord): SerializedRecord | Promise<SerializedRecord> {
    this.encryptedColumns.ensureSchema(table);
    const internalColumnNames = this.internalColumnNames(table);
    let dropsInternal = false;
    let envelopes: EnvelopeCell[] | undefined;
    for (const columnName in serializedRecord) {
      if (internalColumnNames.has(columnName)) {
        dropsInternal = true;
        continue;
      }

      const parsed = this.envelope.parse(serializedRecord[columnName]);
      if (parsed) {
        (envelopes ??= []).push({ columnName, owner: parsed.owner, version: parsed.version });
      }
    }

    if (!dropsInternal && !envelopes) {
      return serializedRecord;
    }

    const prepared: SerializedRecord = {};
    for (const columnName in serializedRecord) {
      if (!internalColumnNames.has(columnName)) {
        prepared[columnName] = serializedRecord[columnName];
      }
    }

    if (!envelopes) {
      return prepared;
    }

    this.assertServerSide();
    return this.decryptInto(prepared, envelopes);
  }

  /**
   * The key owner for a row being written — its permission-source scope owner:
   * `DbEncryptionConfig.resolveKeyOwner` when the deployment supplies one (richer sharing
   * models map scope→owner there), else the row's `scope` column value (the framework's
   * scope columns hold the owning user's id).
   */
  async resolveKeyOwnerForWrite(table: Table<any>, record: any): Promise<string> {
    const config = getDbEncryptionConfig();
    if (config.resolveKeyOwner) {
      const owner = await config.resolveKeyOwner({ table, record });
      if (owner) {
        return owner;
      }
    }

    if (typeof record.scope === 'string' && record.scope.length > 0) {
      return record.scope;
    }

    throw new EncryptedColumnConfigError(
      `(${table.name}) Cannot resolve the key owner for a write to an encrypted column: the row ` +
        `carries no 'scope' value and DbEncryptionConfig.resolveKeyOwner resolved nothing. ` +
        `Scoped tables get this automatically; other tables must supply resolveKeyOwner.`
    );
  }

  private async decryptInto(prepared: SerializedRecord, envelopes: EnvelopeCell[]): Promise<SerializedRecord> {
    for (const cell of envelopes) {
      const key = await new DataKeyStore().getKeyByVersion(cell.owner, cell.version);
      prepared[cell.columnName] = this.envelope.decrypt(prepared[cell.columnName] as string, key);
    }

    return prepared;
  }

  /** The table's framework-derived companion column names — resolved once per table per instance, not per row. */
  private internalColumnNames(table: Table<any>): Set<string> {
    if (this.internalNames?.table === table) {
      return this.internalNames.names;
    }

    const names = new Set<string>();
    for (const prop of Object.keys(table.columns)) {
      const column = (table.columns as any)[prop];
      if (this.encryptedColumns.isInternalColumn(column)) {
        names.add(column.name);
      }
    }

    this.internalNames = { table, names };
    return names;
  }

  private assertServerSide(): void {
    if (typeof self !== 'undefined') {
      throw new Error(
        `Column encryption executes where the database driver runs (the server); the browser ` +
          `must reach encrypted tables through DbService.`
      );
    }
  }
}
