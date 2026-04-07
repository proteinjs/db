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
   * Uses serialization to normalize values (e.g. Reference objects, Moment, JSON) before comparison.
   *
   * The comparison checks that every value in the source record exists with the same value
   * in the existing DB record. Extra keys in the DB record are ignored — table watchers
   * and hooks may enrich records with additional data after insert/update.
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

  /**
   * Find the first point of divergence between source and existing values.
   * Returns a description of the mismatch path, or null if they match.
   * For objects, extra keys in `existing` are ignored — they may have been added by
   * table watchers or hooks after the source record was loaded.
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

    for (const key of Object.keys(source)) {
      // Skip undefined values — they don't survive JSON serialization (JSON.stringify
      // drops undefined), so the DB record won't have them.
      if (source[key] === undefined) {
        continue;
      }
      if (!(key in existing)) {
        return `${path}.${key}: key missing in existing`;
      }
      const result = this.findMismatchPath(source[key], existing[key], `${path}.${key}`);
      if (result) {
        return result;
      }
    }

    return null;
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
}
