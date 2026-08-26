import { Logger } from '@proteinjs/logger';
import { QueryBuilder } from '@proteinjs/db-query';
import { getSourceRecordLoaders, SourceRecord, getSourceRecordTables } from './SourceRecord';
import { Table } from '../Table';
import { Db, getDbAsSystem } from '../Db';
import { SourceRecordRepo } from './SourceRecordRepo';
import { RecordSerializer } from '../Record';

type DeclaredRecord = {
  /** The owning package (the declaring loader's package) — the grain the sync prunes within. */
  source: string;
  record: Omit<SourceRecord, 'created' | 'updated'>;
};

type SourceRecordsMap = {
  [tableName: string]: { table: Table<any>; records: DeclaredRecord[] };
};

/** What one boot of the sync did to one source-record table. */
export type SourceRecordTableLoadSummary = {
  inserts: number;
  updates: number;
  unchanged: number;
  adopted: number;
  deletes: number;
  removedUpdates: number;
  /** Rows stamped by a newer version of their declaring package — left exactly as they are. */
  skippedNewer: number;
  /** Source-loaded rows with no owner stamp that no declaration in this build claims. */
  unowned: number;
};

export type SourceRecordLoadSummary = { [tableName: string]: SourceRecordTableLoadSummary };

export class SourceRecordLoader {
  private logger = new Logger({ name: this.constructor.name });

  /** Memo of resolved package versions — one resolution (and at most one warning) per source. */
  private sourceVersions = new Map<string, string | undefined>();

  /**
   * One boot of the source-record sync, per source-record table in this build. Returns what it
   * did to each table (also logged).
   *
   * Ownership model — every row has one owner, the package that declares it, ordered by that
   * package's version:
   * - A boot speaks only for the packages it carries. Rows owned by a package this build does
   *   not carry are never touched: several servers running different builds against one shared
   *   database coexist without pruning each other's rows.
   * - Within a package, a boot speaks only for its own version or older. A row stamped by a
   *   NEWER version of the same package is left exactly as it is — neither pruned nor rewritten —
   *   so ordinary version skew (an older build restarting against rows a newer build added or
   *   redefined) cannot delete or churn data. The newest version stays authoritative for
   *   genuine removals and redefinitions.
   * - A package in the build is authoritative for all of its rows on every table, including
   *   tables it no longer declares anything for: dropping the last declaration is a removal.
   * - Rows with no owner stamp (written before `source_package` existed) are claimed by the
   *   declaration that still matches them; the rest are reported as unowned and left alone.
   *
   * Accepted residuals: a package removed from every build leaves its rows behind (no surviving
   * boot carries its authority — clean up explicitly); two builds of one package at the SAME
   * version with differing sets (uncommitted local skew) are last-writer-wins, since versions
   * cannot order them.
   *
   * With no argument, every source-record table is synced (the `Db.init` full pass). Passing
   * `onlyTable` scopes the sync to that one table — the pre-schema-sync migration phase uses
   * this to land the migration ledger's rows before the full schema sync has run (see
   * {@link MigrationRunner.runPreSchemaSyncMigrations}); the later full pass re-reconciles the
   * same rows idempotently under the same ownership model.
   */
  async load(onlyTable?: Table<any>): Promise<SourceRecordLoadSummary> {
    const { tables, buildSources } = await this.getDeclarations();
    const db = getDbAsSystem();
    const summary: SourceRecordLoadSummary = {};
    for (const tableName in tables) {
      if (onlyTable && tableName !== onlyTable.name) {
        continue;
      }
      const { table, records } = tables[tableName];
      // 'id' unless the table declares a natural key (validated: unique-indexed, present and
      // unambiguous across declarations).
      const keyProperty = this.validateSyncKey(
        table,
        records.map(({ record }) => record)
      );
      // The exclusion set is the UNION of every key the build declares for the table: a key
      // declared by ANY package in this build is re-owned by the stamp leg, never pruned (a
      // declaration moving between packages within one build must not transit a delete+re-insert).
      const allDeclaredKeys = records.map(({ record }) => (record as any)[keyProperty]);
      const removed = await this.reconcileRemoved(db, table, keyProperty, buildSources, allDeclaredKeys);

      let insertCount = 0;
      let updateCount = 0;
      let unchangedCount = 0;
      let adoptedCount = 0;
      let skippedNewer = removed.skippedNewer;
      for (const { source, record } of records) {
        let sourceRecord = record;
        sourceRecord.isLoadedFromSource = true;
        // Ownership stamp: the declaring package (and its version) claims the row. Stamped
        // before the drift comparison so pre-existing rows (including pre-source_package legacy
        // rows and rows whose declaration moved packages) converge to the current owner on
        // their next boot.
        sourceRecord.sourcePackage = source;
        const sourceVersion = this.sourceVersion(source);
        if (sourceVersion !== undefined) {
          sourceRecord.sourcePackageVersion = sourceVersion;
        }
        const existingRecord = await db.get(table, { [keyProperty]: (sourceRecord as any)[keyProperty] });
        if (existingRecord) {
          if (
            existingRecord.sourcePackage === source &&
            this.isNewerStamp(existingRecord.sourcePackageVersion, sourceVersion)
          ) {
            // A newer version of this very package already defined the row: this build's older
            // definition does not land, and the row's stamp is not downgraded.
            skippedNewer += 1;
            new SourceRecordRepo().loadSourceRecord(table.name, existingRecord);
            continue;
          }

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

      const unowned = await this.countUnowned(db, table, keyProperty);
      summary[table.name] = {
        inserts: insertCount,
        updates: updateCount,
        unchanged: unchangedCount,
        adopted: adoptedCount,
        deletes: removed.deleteCount,
        removedUpdates: removed.removedUpdateCount,
        skippedNewer,
        unowned,
      };
      this.logger.info({
        message: `(${table.name}) Loaded ${records.length} ${records.length == 1 ? 'record' : 'records'} from source`,
        obj: summary[table.name],
      });
    }

    return summary;
  }

  /**
   * The removed-reconcile leg: rows owned by a package this build carries, at that package's
   * version or older, that NO package in this build still declares
   * (`is_loaded_from_source = true AND source_package IN <build's packages> AND <key> NOT IN
   * <build's declared keys for the table>`, minus rows stamped by a newer version of their
   * package) are handled per the table's `onSourceRemoved` policy — delete (default), keep, or
   * update with a patch. The update leg applies the patch only to rows whose fields actually
   * differ (idempotent boots), through `Db.update` so table watchers observe each write.
   * See {@link load} for the ownership model.
   */
  private async reconcileRemoved(
    db: Db,
    table: Table<any>,
    keyProperty: string,
    buildSources: Set<string>,
    allDeclaredKeys: unknown[]
  ): Promise<{ deleteCount: number; removedUpdateCount: number; skippedNewer: number }> {
    const policy = table.sourceRecordOptions.onSourceRemoved ?? 'delete';
    if (policy === 'keep' || buildSources.size == 0) {
      return { deleteCount: 0, removedUpdateCount: 0, skippedNewer: 0 };
    }

    const qb = QueryBuilder.fromObject<SourceRecord>({ isLoadedFromSource: true }, table.name);
    qb.condition({ field: 'sourcePackage', operator: 'IN', value: Array.from(buildSources) as any });
    if (allDeclaredKeys.length > 0) {
      qb.condition({ field: keyProperty as any, operator: 'NOT IN', value: allDeclaredKeys as any });
    }

    const candidates: SourceRecord[] = await db.query(table, qb);
    const stampedNewer = (candidate: SourceRecord) =>
      this.isNewerStamp(candidate.sourcePackageVersion, this.sourceVersion(candidate.sourcePackage as string));
    const removedRecords = candidates.filter((candidate) => !stampedNewer(candidate));
    const skippedNewer = candidates.length - removedRecords.length;
    if (skippedNewer > 0) {
      this.logger.info({
        message: `(${table.name}) Left ${skippedNewer} record${skippedNewer == 1 ? '' : 's'} stamped by a newer version of ${skippedNewer == 1 ? 'its' : 'their'} package — not treated as removed`,
        obj: { [keyProperty]: candidates.filter(stampedNewer).map((candidate) => (candidate as any)[keyProperty]) },
      });
    }

    if (removedRecords.length == 0) {
      return { deleteCount: 0, removedUpdateCount: 0, skippedNewer };
    }

    if (policy === 'delete') {
      const deleteQb = QueryBuilder.fromObject<SourceRecord>({ isLoadedFromSource: true }, table.name);
      deleteQb.condition({ field: 'id', operator: 'IN', value: removedRecords.map((record) => record.id) });
      return { deleteCount: await db.delete(table, deleteQb), removedUpdateCount: 0, skippedNewer };
    }

    let removedUpdateCount = 0;
    for (const removedRecord of removedRecords) {
      if (await this.hasChanges(table, policy.update, removedRecord)) {
        await db.update(table, { id: removedRecord.id, ...policy.update });
        removedUpdateCount += 1;
        this.logger.info({
          message: `(${table.name}) Applied onSourceRemoved update to record removed from source`,
          obj: {
            id: removedRecord.id,
            [keyProperty]: (removedRecord as any)[keyProperty],
            source: removedRecord.sourcePackage,
          },
        });
      }
    }

    return { deleteCount: 0, removedUpdateCount, skippedNewer };
  }

  /**
   * Source-loaded rows with no owner stamp that no declaration in this build claimed on this
   * boot (the stamp leg has already run). They predate `source_package`, or their declaring
   * package is not in this build; nobody prunes them. Reported so they are visible, never acted
   * on. Tables that keep removed rows (`onSourceRemoved: 'keep'`) opted out of removal
   * semantics altogether, so there is nothing to explain there.
   */
  private async countUnowned(db: Db, table: Table<any>, keyProperty: string): Promise<number> {
    if ((table.sourceRecordOptions.onSourceRemoved ?? 'delete') === 'keep') {
      return 0;
    }

    const qb = QueryBuilder.fromObject<SourceRecord>({ isLoadedFromSource: true }, table.name);
    qb.condition({ field: 'sourcePackage', operator: 'IS NULL' });
    const unowned: SourceRecord[] = await db.query(table, qb);
    if (unowned.length > 0) {
      this.logger.warn({
        message: `(${table.name}) ${unowned.length} source-loaded ${unowned.length == 1 ? 'record has' : 'records have'} no owning package and no declaration in this build — left untouched`,
        obj: { [keyProperty]: unowned.map((record) => (record as any)[keyProperty]) },
      });
    }

    return unowned.length;
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

  /**
   * Every source-record table in this build with the records declared for it, plus the set of
   * packages that declare ANY source record in this build — the packages this boot speaks for.
   */
  private async getDeclarations(): Promise<{ tables: SourceRecordsMap; buildSources: Set<string> }> {
    const tables: SourceRecordsMap = {};
    for (const table of getSourceRecordTables()) {
      tables[table.name] = { table, records: [] };
    }

    const buildSources = new Set<string>();
    for (const { source, loader } of getSourceRecordLoaders()) {
      buildSources.add(source);
      if (!tables[loader.table.name]) {
        tables[loader.table.name] = { table: loader.table, records: [] };
      }

      tables[loader.table.name].records.push({ source, record: loader.record });
    }

    return { tables, buildSources };
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

  /** Memoized {@link resolveSourceVersion} — one resolution (and at most one warning) per source. */
  private sourceVersion(source: string): string | undefined {
    if (!this.sourceVersions.has(source)) {
      this.sourceVersions.set(source, this.resolveSourceVersion(source));
    }

    return this.sourceVersions.get(source);
  }

  /**
   * The declaring package's version, read from its own package.json at runtime. Resolution runs
   * from the process cwd — the booting server's package, the one dependency tree every declaring
   * package is reachable from (`@proteinjs/db` itself does not depend on the packages that
   * declare records, so module-relative resolution could never find them). The package's entry
   * is resolved (honoring exports maps, where `<pkg>/package.json` is usually not requireable),
   * then the nearest package.json whose `name` matches is read walking up from it.
   *
   * Returns undefined where resolution is impossible — no Node `require` (browser bundles), or a
   * package not resolvable from cwd. The sync then has no place in the version order for that
   * package: it never touches its version-stamped rows, and what it writes is unversioned
   * (see {@link isNewerStamp}). Logged once per boot so a misconfigured cwd is visible.
   */
  private resolveSourceVersion(source: string): string | undefined {
    // The ambient CJS `require` — the only require carrying `.resolve` (module.require does
    // not). Every use below goes through the variable, so bundlers never see a statically
    // analyzable `require(...)` call; in a browser bundle the runtime attempts throw into
    // their catches and the method degrades to undefined.
    const nodeRequire: NodeRequire | undefined =
      typeof require === 'function' && typeof require.resolve === 'function' ? require : undefined;
    const cwd = typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : undefined;
    if (nodeRequire && cwd) {
      try {
        const entryPath = nodeRequire.resolve(source, { paths: [cwd] });
        const path = nodeRequire('path');
        const fs = nodeRequire('fs');
        // Walk up from the entry file to the package's own package.json (the name check skips
        // nested stubs like a dist/package.json); stop at the filesystem root.
        for (let directory = path.dirname(entryPath); ; directory = path.dirname(directory)) {
          const candidate = path.join(directory, 'package.json');
          if (fs.existsSync(candidate)) {
            const packageJson = JSON.parse(fs.readFileSync(candidate, 'utf8'));
            if (packageJson?.name === source && typeof packageJson.version === 'string') {
              return packageJson.version;
            }
          }

          if (path.dirname(directory) === directory) {
            break;
          }
        }
      } catch (error) {
        // Unresolvable from cwd — reported below.
      }
    }

    this.logger.warn({
      message: `Could not resolve a version for source package '${source}' from '${cwd}' — its records sync without version ordering (this build never touches its version-stamped rows)`,
    });
    return undefined;
  }

  /**
   * Whether a row's version stamp is strictly newer than the reconciling build's version of the
   * same package — the guard that makes version skew of one package safe on a shared database:
   * an older build never prunes (or flags) rows a newer build of the same package declared.
   *
   * Unversioned stamps (NULL — legacy rows, or builds whose version could not be resolved)
   * carry no ordering and stay reconcilable (last-writer-wins, the pre-version behavior). A
   * build whose OWN version is unresolvable cannot place itself in the order, so it never
   * touches a version-stamped row — conservative: prefer leaving a removed row behind over
   * deleting one that might be newer.
   */
  private isNewerStamp(stampedVersion: string | null | undefined, reconcilingVersion: string | undefined): boolean {
    if (stampedVersion == null) {
      return false;
    }

    if (reconcilingVersion == null) {
      return true;
    }

    const comparison = this.compareVersions(stampedVersion, reconcilingVersion);
    return comparison === undefined ? true : comparison > 0;
  }

  /**
   * Semver comparison (major.minor.patch, prerelease-aware): negative when a < b, 0 when equal,
   * positive when a > b, and undefined when either side does not parse as semver (unorderable —
   * the caller treats that conservatively).
   */
  private compareVersions(a: string, b: string): number | undefined {
    const parse = (version: string): { main: number[]; prerelease?: string[] } | undefined => {
      const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?/.exec(version.trim());
      if (!match) {
        return undefined;
      }

      return { main: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split('.') };
    };

    const parsedA = parse(a);
    const parsedB = parse(b);
    if (!parsedA || !parsedB) {
      return undefined;
    }

    for (let i = 0; i < 3; i++) {
      if (parsedA.main[i] !== parsedB.main[i]) {
        return parsedA.main[i] - parsedB.main[i];
      }
    }

    if (!parsedA.prerelease && !parsedB.prerelease) {
      return 0;
    }
    if (!parsedA.prerelease) {
      return 1; // a release outranks any prerelease of the same triple
    }
    if (!parsedB.prerelease) {
      return -1;
    }

    const length = Math.max(parsedA.prerelease.length, parsedB.prerelease.length);
    for (let i = 0; i < length; i++) {
      const identifierA = parsedA.prerelease[i];
      const identifierB = parsedB.prerelease[i];
      if (identifierA === undefined) {
        return -1; // fewer identifiers sorts first when all shared ones are equal
      }
      if (identifierB === undefined) {
        return 1;
      }

      const numericA = /^\d+$/.test(identifierA) ? Number(identifierA) : undefined;
      const numericB = /^\d+$/.test(identifierB) ? Number(identifierB) : undefined;
      if (numericA !== undefined && numericB !== undefined) {
        if (numericA !== numericB) {
          return numericA - numericB;
        }
      } else if (numericA !== undefined) {
        return -1; // numeric identifiers sort before alphanumeric ones
      } else if (numericB !== undefined) {
        return 1;
      } else if (identifierA !== identifierB) {
        return identifierA < identifierB ? -1 : 1;
      }
    }

    return 0;
  }
}
