import { Logger } from '@proteinjs/logger';
import { QueryBuilder } from '@proteinjs/db-query';
import { getSourceRecordLoaders, SourceRecord, getSourceRecordTables } from './SourceRecord';
import { Table } from '../Table';
import { Db, getDbAsSystem } from '../Db';
import { SourceRecordRepo } from './SourceRecordRepo';
import { RecordSerializer } from '../Record';

type SourceRecordsMap = {
  [tableName: string]: { table: Table<any>; records: Omit<SourceRecord, 'created' | 'updated'>[] };
};

export class SourceRecordLoader {
  private logger = new Logger({ name: this.constructor.name });

  async load() {
    const sourceRecordsMap = await this.getSourceRecordsMap();
    const db = getDbAsSystem();
    for (const tableName in sourceRecordsMap) {
      const { table, records } = sourceRecordsMap[tableName];
      // 'id' unless the table declares a natural key (validated: unique-indexed, present and
      // unambiguous across declarations).
      const keyProperty = this.validateSyncKey(table, records);
      const declaredKeys = records.map((record) => (record as any)[keyProperty]);
      const { deleteCount, removedUpdateCount } = await this.reconcileRemoved(db, table, keyProperty, declaredKeys);

      let insertCount = 0;
      let updateCount = 0;
      let unchangedCount = 0;
      let adoptedCount = 0;
      for (let sourceRecord of records) {
        sourceRecord.isLoadedFromSource = true;
        const existingRecord = await db.get(table, { [keyProperty]: (sourceRecord as any)[keyProperty] });
        if (existingRecord) {
          if (existingRecord.id !== sourceRecord.id) {
            // Adopt in place: the existing row keeps its id — other tables may reference it.
            // The declared id is only ever used for fresh inserts.
            sourceRecord = { ...sourceRecord, id: existingRecord.id };
          }

          if (existingRecord.isLoadedFromSource !== true) {
            // A pre-existing (runtime-created) row is being taken over by a declaration —
            // deliberate, but loud: a declaration asserts ownership of the row's identity.
            adoptedCount += 1;
            this.logger.info({
              message: `(${table.name}) Adopting existing record into source ownership`,
              obj: { [keyProperty]: (sourceRecord as any)[keyProperty], id: existingRecord.id },
            });
          }

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

        // Registered under the DB id (= the adopted id when an existing row matched by natural key).
        new SourceRecordRepo().loadSourceRecord(table.name, sourceRecord as any);
      }

      this.logger.info({
        message: `(${table.name}) Loaded ${records.length} ${records.length == 1 ? 'record' : 'records'} from source`,
        obj: {
          inserts: insertCount,
          updates: updateCount,
          unchanged: unchangedCount,
          adopted: adoptedCount,
          deletes: deleteCount,
          removedUpdates: removedUpdateCount,
        },
      });
    }
  }

  /**
   * The removed-reconcile leg: rows previously loaded from source whose declaration no longer
   * exists (`is_loaded_from_source = true AND <key> NOT IN declared`), handled per the table's
   * `onSourceRemoved` policy — delete (default), keep, or update with a patch. The update leg
   * applies the patch only to rows whose fields actually differ (idempotent boots), through
   * `Db.update` so table watchers observe each write.
   */
  private async reconcileRemoved(
    db: Db,
    table: Table<any>,
    keyProperty: string,
    declaredKeys: unknown[]
  ): Promise<{ deleteCount: number; removedUpdateCount: number }> {
    const policy = table.sourceRecordOptions.onSourceRemoved ?? 'delete';
    if (policy === 'keep') {
      return { deleteCount: 0, removedUpdateCount: 0 };
    }

    const qb = QueryBuilder.fromObject<SourceRecord>({ isLoadedFromSource: true }, table.name);
    if (declaredKeys.length > 0) {
      qb.condition({ field: keyProperty as any, operator: 'NOT IN', value: declaredKeys as any });
    }

    if (policy === 'delete') {
      return { deleteCount: await db.delete(table, qb), removedUpdateCount: 0 };
    }

    let removedUpdateCount = 0;
    const removedRecords = await db.query(table, qb);
    for (const removedRecord of removedRecords) {
      if (await this.hasChanges(table, policy.update, removedRecord)) {
        await db.update(table, { id: removedRecord.id, ...policy.update });
        removedUpdateCount += 1;
        this.logger.info({
          message: `(${table.name}) Applied onSourceRemoved update to record removed from source`,
          obj: { id: removedRecord.id, [keyProperty]: (removedRecord as any)[keyProperty] },
        });
      }
    }

    return { deleteCount: 0, removedUpdateCount };
  }

  /**
   * Resolve and validate the property the sync keys on: `id` unless the table declares
   * `sourceRecordOptions.naturalKey`. A natural key must be schema-unique (a `ColumnOptions.unique`
   * column or a single-column unique index in `Table.indexes`), present on every declaration, and
   * unambiguous across declarations — each violation fails boot loudly by name.
   */
  private validateSyncKey(table: Table<any>, records: Omit<SourceRecord, 'created' | 'updated'>[]): string {
    const naturalKey = table.sourceRecordOptions.naturalKey;
    if (!naturalKey) {
      return 'id';
    }

    const column = (table.columns as any)[naturalKey];
    if (!column) {
      throw new Error(
        `(${table.name}) sourceRecordOptions.naturalKey '${naturalKey}' is not a column property on the table`
      );
    }

    const uniqueByColumn = column.options?.unique?.unique === true;
    const uniqueByIndex = (table.indexes ?? []).some(
      (index) => index.unique === true && index.columns.length === 1 && String(index.columns[0]) === naturalKey
    );
    if (!uniqueByColumn && !uniqueByIndex) {
      throw new Error(
        `(${table.name}) sourceRecordOptions.naturalKey '${naturalKey}' requires the column to be unique — ` +
          `declare ColumnOptions.unique on it (or a single-column unique index in Table.indexes) so ` +
          `natural-key adoption cannot match ambiguously`
      );
    }

    const seen = new Map<unknown, true>();
    for (const record of records) {
      const value = (record as any)[naturalKey];
      if (value === undefined || value === null) {
        throw new Error(
          `(${table.name}) A source record declaration is missing its natural key '${naturalKey}' (declared id: '${record.id}')`
        );
      }

      if (seen.has(value)) {
        throw new Error(
          `(${table.name}) Two source record declarations share the natural key '${naturalKey}' = '${value}' — ` +
            `declarations must be unique by natural key`
        );
      }

      seen.set(value, true);
    }

    return naturalKey;
  }

  /**
   * Compare source record fields against the existing DB record to detect actual changes.
   * Only fields present on the source record are compared, ignoring `id`, `created`, `updated`
   * (`id` because natural-key adoption keeps the existing row's id — the declared id must not
   * register as perpetual drift; `Db.update` never writes id anyway).
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
      if (columnName === 'id' || columnName === 'created' || columnName === 'updated') {
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
        sourceRecordsMap[sourceRecordTable.name] = { table: sourceRecordTable, records: [] };
      }
    }

    const sourceRecordLoaders = getSourceRecordLoaders();
    for (const sourceRecordLoader of sourceRecordLoaders) {
      if (!sourceRecordsMap[sourceRecordLoader.table.name]) {
        sourceRecordsMap[sourceRecordLoader.table.name] = {
          table: sourceRecordLoader.table,
          records: [],
        };
      }

      sourceRecordsMap[sourceRecordLoader.table.name].records.push(sourceRecordLoader.record);
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
