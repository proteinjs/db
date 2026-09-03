import { QueryBuilder } from '@proteinjs/db-query';
import type { Table } from '../Table';
import type { Record } from '../Record';
import { EncryptedColumns, EncryptionSearchToken } from './EncryptedColumns';
import { DataKeyStore } from './DataKeyStore';
import { SearchTokenizer } from './SearchTokenizer';

/**
 * Search-token upkeep for `encrypted: { searchable: 'contains' }` columns: the same write
 * that stores a row's ciphertext also derives the value's search tokens (words, trigrams,
 * short prefixes — `SearchTokenizer`), fingerprints each with the row owner's index key,
 * and maintains them as rows of the derived token table (`EncryptedColumns.tokenTableFor`)
 * — the portable inverted index the query translator's candidate step reads.
 *
 * Invoked by `Db` around its DML (insert/update/delete), through a SYSTEM Db riding the
 * same driver and ambient transaction — inside a transaction, token rows commit or roll
 * back with the row; outside one, the token write follows the row write immediately.
 */
export class EncryptionTokenMaintenance {
  private static readonly ID_CHUNK_SIZE = 500;
  private encryptedColumns = new EncryptedColumns();
  private tokenizer = new SearchTokenizer();

  /** Write token rows for the contains-searchable columns present in an inserted record. */
  async afterInsert(
    table: Table<any>,
    record: any,
    keyOwner: string,
    systemDb: TokenMaintenanceDb,
    options: TokenMaintenanceOptions = {}
  ): Promise<void> {
    const touched = this.touchedContainsProps(table, record);
    if (touched.length === 0 || options.plaintext) {
      return; // a decrypt-out write stores plaintext and carries no fingerprints
    }

    await this.writeTokenRows(table, [record.id], record, touched, keyOwner, systemDb);
  }

  /** Rewrite token rows of the touched contains-searchable columns for the updated row ids. */
  async afterUpdate(
    table: Table<any>,
    recordIds: string[],
    record: any,
    keyOwner: string,
    systemDb: TokenMaintenanceDb,
    options: TokenMaintenanceOptions = {}
  ): Promise<void> {
    const touched = this.touchedContainsProps(table, record);
    if (touched.length === 0 || recordIds.length === 0) {
      return;
    }

    const tokenTable = this.encryptedColumns.tokenTableFor(table)!;
    const touchedColumnNames = touched.map((prop) => ((table.columns as any)[prop] as { name: string }).name);
    for (const idsChunk of this.chunk(recordIds, EncryptionTokenMaintenance.ID_CHUNK_SIZE)) {
      const deleteQb = new QueryBuilder<EncryptionSearchToken>(tokenTable.name)
        .condition({ field: 'recordId', operator: 'IN', value: idsChunk })
        .condition({ field: 'columnName', operator: 'IN', value: touchedColumnNames });
      await systemDb.delete(tokenTable, deleteQb);
    }

    if (options.plaintext) {
      return; // decrypt-out: the stale fingerprints are gone, plaintext carries none
    }
    await this.writeTokenRows(table, recordIds, record, touched, keyOwner, systemDb);
  }

  /** Remove every token row of deleted records. */
  async afterDelete(table: Table<any>, deletedIds: string[], systemDb: TokenMaintenanceDb): Promise<void> {
    const tokenTable = this.encryptedColumns.tokenTableFor(table);
    if (!tokenTable || deletedIds.length === 0) {
      return;
    }

    for (const idsChunk of this.chunk(deletedIds, EncryptionTokenMaintenance.ID_CHUNK_SIZE)) {
      const deleteQb = new QueryBuilder<EncryptionSearchToken>(tokenTable.name).condition({
        field: 'recordId',
        operator: 'IN',
        value: idsChunk,
      });
      await systemDb.delete(tokenTable, deleteQb);
    }
  }

  private async writeTokenRows(
    table: Table<any>,
    recordIds: string[],
    record: any,
    touchedProps: string[],
    keyOwner: string,
    systemDb: TokenMaintenanceDb
  ): Promise<void> {
    const tokenTable = this.encryptedColumns.tokenTableFor(table)!;
    const writeKey = await new DataKeyStore().getWriteKey(keyOwner);
    for (const prop of touchedProps) {
      const value = record[prop];
      if (value === null) {
        continue; // null values carry no tokens
      }

      const columnName = ((table.columns as any)[prop] as { name: string }).name;
      const fingerprints = this.tokenizer.fingerprints(this.tokenizer.tokensForValue(String(value)), writeKey.indexKey);
      // One batched DML per chunk (Db.insertAll) — a long searchable value derives hundreds
      // of fingerprints, and per-token statements would pay one round trip each (the class
      // that blew Spanner's transaction deadline on bulk tree writes).
      const tokenRows: Omit<EncryptionSearchToken, keyof Record>[] = [];
      for (const recordId of recordIds) {
        for (const token of fingerprints) {
          tokenRows.push({ recordId, columnName, token });
        }
      }
      await systemDb.insertAll(tokenTable, tokenRows);
    }
  }

  private touchedContainsProps(table: Table<any>, record: any): string[] {
    return this.encryptedColumns.containsProps(table).filter((prop) => typeof record[prop] !== 'undefined');
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }

    return chunks;
  }
}

/** `plaintext` = the decrypt-out write mode (see `Db.asDecryptOut`): existing token rows are removed, none are written. */
export type TokenMaintenanceOptions = { plaintext?: boolean };

/** The Db surface token maintenance needs (a system Db instance — see class doc). */
export interface TokenMaintenanceDb {
  insertAll<T extends Record>(table: Table<T>, records: Omit<T, keyof Record>[]): Promise<number>;
  delete<T extends Record>(table: Table<T>, query: QueryBuilder<T>): Promise<number>;
}
