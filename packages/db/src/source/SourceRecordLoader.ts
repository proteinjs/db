import { Logger } from '@proteinjs/logger';
import { QueryBuilder } from '@proteinjs/db-query';
import { getSourceRecordLoaders, SourceRecord, getSourceRecordTables } from './SourceRecord';
import { Table } from '../Table';
import { getDbAsSystem } from '../Db';
import { SourceRecordRepo } from './SourceRecordRepo';
import { RecordSerializer } from '../Record';

type SourceRecordsMap = {
  [tableName: string]: { table: Table<any>; records: Omit<SourceRecord, 'created' | 'updated'>[]; recordIds: string[] };
};

export class SourceRecordLoader {
  private logger = new Logger({ name: this.constructor.name });

  async load() {
    const sourceRecordsMap = await this.getSourceRecordsMap();
    const db = getDbAsSystem();
    for (const tableName in sourceRecordsMap) {
      let insertCount = 0;
      let updateCount = 0;
      let unchangedCount = 0;
      let deleteCount = 0;
      const table = sourceRecordsMap[tableName].table;
      const sourceRecordIds = sourceRecordsMap[tableName].recordIds;
      if (!table.sourceRecordOptions.doNotDeleteSourceRecordsFromDb) {
        const qb = QueryBuilder.fromObject<SourceRecord>({ isLoadedFromSource: true }, table.name);
        if (sourceRecordIds.length > 0) {
          qb.condition({ field: 'id', operator: 'NOT IN', value: sourceRecordIds });
        }

        deleteCount = await db.delete(table, qb);
      }

      const sourceRecords = sourceRecordsMap[tableName].records;
      for (let sourceRecord of sourceRecords) {
        sourceRecord.isLoadedFromSource = true;
        const existingRecord = await db.get(table, { id: sourceRecord.id });
        if (existingRecord) {
          if (await this.hasChanges(table, sourceRecord, existingRecord)) {
            await db.update(table, sourceRecord);
            updateCount += 1;
          } else {
            unchangedCount += 1;
          }
        } else {
          const dbSourceRecord = await db.insert(table, sourceRecord);
          sourceRecord = { ...sourceRecord, ...dbSourceRecord };
          insertCount += 1;
        }

        new SourceRecordRepo().loadSourceRecord(table.name, sourceRecord as any);
      }

      this.logger.info({
        message: `(${table.name}) Loaded ${sourceRecords.length} ${sourceRecords.length == 1 ? 'record' : 'records'} from source`,
        obj: {
          inserts: insertCount,
          updates: updateCount,
          unchanged: unchangedCount,
          deletes: deleteCount,
        },
      });
    }
  }

  /**
   * Compare source record fields against the existing DB record to detect actual changes.
   * Only fields present on the source record are compared (ignoring `created`, `updated`).
   * Uses serialization to normalize values (e.g. Reference objects, Moment, JSON) before
   * comparison, then delegates to {@link findMismatchPath}.
   *
   * Object-valued fields (e.g. `JsonColumn` blobs) are treated as source-authoritative:
   * any structural drift, including extra keys left behind by earlier source versions,
   * triggers a rewrite. Primitive columns retain their existing semantics.
   */
  private async hasChanges(table: Table<any>, sourceRecord: any, existingRecord: any): Promise<boolean> {
    const serializer = new RecordSerializer(table);
    const serializedSource = await serializer.serialize(sourceRecord);
    const serializedExisting = await serializer.serialize(existingRecord);
    for (const columnName in serializedSource) {
      if (columnName === 'created' || columnName === 'updated') {
        continue;
      }

      const sourceValue = serializedSource[columnName];
      const existingValue = serializedExisting[columnName];
      if (this.findMismatchPath(sourceValue, existingValue, columnName)) {
        return true;
      }
    }

    return false;
  }

  private async getSourceRecordsMap() {
    const sourceRecordsMap: SourceRecordsMap = {};
    const sourceRecordTables = getSourceRecordTables();
    for (const sourceRecordTable of sourceRecordTables) {
      if (!sourceRecordsMap[sourceRecordTable.name]) {
        sourceRecordsMap[sourceRecordTable.name] = { table: sourceRecordTable, records: [], recordIds: [] };
      }
    }

    const sourceRecordLoaders = getSourceRecordLoaders();
    for (const sourceRecordLoader of sourceRecordLoaders) {
      if (!sourceRecordsMap[sourceRecordLoader.table.name]) {
        sourceRecordsMap[sourceRecordLoader.table.name] = {
          table: sourceRecordLoader.table,
          records: [],
          recordIds: [],
        };
      }

      sourceRecordsMap[sourceRecordLoader.table.name].records.push(sourceRecordLoader.record);
      sourceRecordsMap[sourceRecordLoader.table.name].recordIds.push(sourceRecordLoader.record.id);
    }

    return sourceRecordsMap;
  }

  /**
   * Find the first point of divergence between source and existing values.
   * Returns a description of the mismatch path, or null if they match.
   *
   * For object-valued fields (e.g. a `JsonColumn` blob), source is treated as
   * fully authoritative: any structural drift — extra keys in existing, missing
   * keys in existing, or value differences anywhere in the subtree — produces
   * a mismatch. Comparison goes through {@link SourceRecordLoader.canonicalStringify}
   * so that key ordering (which backing stores may canonicalize alphabetically)
   * does not cause false positives.
   *
   * For arrays, order and length must match exactly.
   */
  private findMismatchPath(source: any, existing: any, path: string): string | null {
    if (source === existing) {
      return null;
    }

    if (source == null || existing == null) {
      if (source == existing) {
        return null;
      }
      return `${path}: source=${JSON.stringify(source)}, existing=${JSON.stringify(existing)}`;
    }

    if (typeof source !== typeof existing) {
      return `${path}: type mismatch: source=${typeof source}, existing=${typeof existing}`;
    }

    if (typeof source !== 'object') {
      const sourceStr = typeof source === 'string' && source.length > 80 ? source.substring(0, 80) + '...' : source;
      const existingStr =
        typeof existing === 'string' && existing.length > 80 ? existing.substring(0, 80) + '...' : existing;
      return `${path}: source=${JSON.stringify(sourceStr)}, existing=${JSON.stringify(existingStr)}`;
    }

    if (Array.isArray(source) !== Array.isArray(existing)) {
      return `${path}: array mismatch: source isArray=${Array.isArray(source)}, existing isArray=${Array.isArray(existing)}`;
    }

    if (Array.isArray(source)) {
      if (source.length !== existing.length) {
        return `${path}: array length: source=${source.length}, existing=${existing.length}`;
      }
      for (let i = 0; i < source.length; i++) {
        const result = this.findMismatchPath(source[i], existing[i], `${path}[${i}]`);
        if (result) {
          return result;
        }
      }
      return null;
    }

    // Both values are non-null, non-array objects. Treat source as authoritative:
    // any structural drift triggers a mismatch. Canonical stringify normalizes
    // key order so storage-side canonicalization (e.g. Spanner alphabetizes JSON
    // keys) doesn't register as drift.
    if (this.canonicalStringify(source) !== this.canonicalStringify(existing)) {
      return `${path}: object differs`;
    }
    return null;
  }

  /**
   * Canonical JSON stringification with recursively sorted object keys.
   *
   * Why this exists: some stores (notably Spanner) canonicalize JSON object
   * keys alphabetically on storage. Source records declared in TypeScript
   * code don't guarantee alphabetical key order, so a plain `JSON.stringify`
   * comparison between source and the existing DB value would produce false
   * mismatches driven purely by key ordering. Sorting keys on both sides
   * normalizes them so semantic equality maps to string equality.
   *
   * Arrays preserve order (order is semantic for arrays); only object keys
   * are sorted.
   */
  private canonicalStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      // Mirror JSON.stringify: undefined array elements serialize as `null`.
      return '[' + value.map((v) => (v === undefined ? 'null' : this.canonicalStringify(v))).join(',') + ']';
    }
    // Mirror JSON.stringify: skip object properties whose value is `undefined`.
    // This keeps source records that declare optional fields (as `undefined`)
    // from being treated as drift vs existing rows that simply don't have the
    // field — `undefined` would never have been written to the DB.
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + this.canonicalStringify(obj[k])).join(',') + '}';
  }
}
