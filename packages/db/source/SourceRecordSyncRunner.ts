import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@proteinjs/logger';
import { QueryBuilder } from '@proteinjs/db-query';
import { getSourceRecordLoaders, SourceRecord, getSourceRecordTables } from '../src/source/SourceRecord';
import { Table } from '../src/Table';
import { Db, getDbAsSystem } from '../src/Db';
import { SourceRecordRepo } from '../src/source/SourceRecordRepo';
import { RecordSerializer, SerializedRecord } from '../src/Record';
import {
  SourceRecordLoadSummary,
  SourceRecordRemovalRefusedError,
  SourceRecordSync,
} from '../src/source/SourceRecordSync';
import { SourceRecordDeclarationDocument } from '../src/source/SourceRecordDeclaration';
import { getSourceRecordDeclarationFiles } from '../src/source/SourceRecordDeclarationFile';
import { SourceRecordStamp } from './SourceRecordStamp';

type DeclaredRecord = {
  /** The owning package (the declaring loader's package) — the grain the sync prunes within. */
  source: string;
  /** The declaration's reflection qualified name and its own name (the loader's class name). */
  qualifiedName: string;
  name: string;
  record: Omit<SourceRecord, 'created' | 'updated'>;
};

type SourceRecordsMap = {
  [tableName: string]: { table: Table<any>; records: DeclaredRecord[] };
};

/** The property the sync keys a table on (`id` or the natural key) and the property that scopes it, when any. */
type SyncKey = { key: string; scope?: string };

/**
 * Whose row an existing, owned row is — from the sync's stamp — and what the boot does with it.
 * - `declaration`: the row still digests to its stamp (or predates stamps): the sync's to write.
 * - `readopted`: the row moved since the sync wrote it and the declaration now EQUALS it on every
 *   declared column: stamped as the declaration's again, nothing else written.
 * - `kept`: the row moved and the declaration did not: the product's, left as it is.
 * - `diverged`: both moved, to different values: the product's, left as it is, warned with both digests.
 */
type Authorship =
  | { verdict: 'declaration' | 'readopted' | 'kept' }
  | { verdict: 'diverged'; rowDigest: string; declarationDigest: string };

/**
 * The one {@link SourceRecordSync}: server-only code (it reads package.json files off the booting
 * process) behind the `@proteinjs/db/source` subpath — a server's boot imports that subpath once,
 * and reflection hands this runner to `Db.init` through `getSourceRecordSync`.
 */
export class SourceRecordSyncRunner implements SourceRecordSync {
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
   * - A declaration never takes over a row the sync does not own through a natural key: a
   *   natural key (an email, say) is an identity the world shares, so a runtime row holding it
   *   may be anyone's — that declaration is REFUSED for the boot (the row untouched, the boot
   *   continuing, one warning naming the declaration, counted `refused`). A declared id, minted
   *   by the declaration itself, still claims a runtime row holding it (see
   *   {@link SourceRecordOptions.naturalKey}). A scoped natural key is the pair (scope, key)
   *   everywhere the key is read ({@link SourceRecordOptions.naturalKeyScope}).
   * - THE AUTHORSHIP PRECEDENCE on the rows the sync owns: every row it writes carries a stamp of
   *   the declared columns as written ({@link SourceRecordStamp}). A row still digesting to its
   *   stamp is the declaration's — updated to a changed declaration, removed when the declaration
   *   is gone. A row the product edited on a declared column since is the PRODUCT's: never
   *   written or removed, whatever the declaration says (counted `kept`), until the declaration
   *   equals it again — then it is re-adopted (stamped, nothing else written, counted `adopted`).
   *   A row the product edited whose declaration ALSO moved, to something else, is a two-sided
   *   divergence: counted `diverged` apart from `kept`, the row untouched, one warning naming the
   *   key and both digests, never a failed boot — the consumer's own reconcile settles it.
   *   Runtime-owned columns a declaration never covers never move a row's authorship.
   * - Declarations come from code (`SourceRecordLoader`) and from declaration FILES
   *   (`SourceRecordDeclarationFile` — a document `source-records pull` wrote, every row declared
   *   by the file's package). A load that would remove more than the table's
   *   `maxRemovedFraction` of the rows the build owns refuses before touching anything.
   * - The version stamp records the version that last WROTE the row (its insert or its last
   *   redefinition). A newer version whose declaration is unchanged writes nothing — it neither
   *   re-stamps the version nor bumps `updated` — so a release that touches no declaration
   *   leaves every row byte-identical (see {@link hasChanges}).
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
      // unambiguous across declarations — as a (scope, key) pair when the key is scoped).
      const syncKey = this.validateSyncKey(
        table,
        records.map(({ record }) => record)
      );
      // The exclusion set is the UNION of every key the build declares for the table: a key
      // declared by ANY package in this build is re-owned by the stamp leg, never pruned (a
      // declaration moving between packages within one build must not transit a delete+re-insert).
      const declaredKeyValues = records.map(({ record }) => (record as any)[syncKey.key]);
      const declaredKeys = new Set(records.map(({ record }) => this.keyText(syncKey, record)));
      const removed = await this.reconcileRemoved(db, table, syncKey, buildSources, declaredKeyValues, declaredKeys);

      let insertCount = 0;
      let updateCount = 0;
      let unchangedCount = 0;
      let adoptedCount = 0;
      let refusedCount = 0;
      let keptCount = removed.keptCount;
      let divergedCount = 0;
      let skippedNewer = removed.skippedNewer;
      for (const { source, qualifiedName, name, record } of records) {
        let sourceRecord = record;
        sourceRecord.isLoadedFromSource = true;
        // Fields derived from the declaration itself (e.g. the migration ledger's `name` = the
        // loader's class name) — merged before the drift comparison, so they backfill existing
        // rows exactly once and the derivation, not the declared record, owns them.
        const derived = table.sourceRecordOptions.fromDeclaration?.({ source, qualifiedName, name });
        if (derived) {
          Object.assign(sourceRecord, derived);
        }
        // Ownership stamp: the declaring package (and its version) claims the row. Stamped
        // before the drift comparison so pre-existing rows (including pre-source_package legacy
        // rows and rows whose declaration moved packages) converge to the current owner on
        // their next boot.
        sourceRecord.sourcePackage = source;
        const sourceVersion = this.sourceVersion(source);
        if (sourceVersion !== undefined) {
          sourceRecord.sourcePackageVersion = sourceVersion;
        }
        const declaredColumns = SourceRecordStamp.declaredColumnNames(table, sourceRecord);
        let existingRecord = await db.get(table, this.keyQuery(syncKey, sourceRecord));
        let reclaimedSoftRemoved = false;
        if (!existingRecord) {
          existingRecord = await this.softRemovedRecordHoldingDeclaredId(
            db,
            table,
            syncKey,
            sourceRecord.id,
            source,
            declaredKeys
          );
          reclaimedSoftRemoved = existingRecord !== undefined;
        }

        if (existingRecord) {
          if (existingRecord.isLoadedFromSource !== true && syncKey.key !== 'id') {
            // A natural key held by a row the sync does not own: never taken over (see load's
            // ownership model). The row stays exactly as it is and the boot goes on.
            refusedCount += 1;
            this.logger.warn({
              message: `(${table.name}) Refused declaration '${name}': a row the sync does not own holds ${this.keyWords(syncKey, sourceRecord)} — the row is left untouched and the declaration does not load while it stands`,
              obj: {
                declaration: qualifiedName,
                ...this.keyQuery(syncKey, sourceRecord),
                id: existingRecord.id,
              },
            });
            continue;
          }

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
            // A natural-key match on a row the sync owns under an environment's own id (one an
            // earlier build adopted): the row keeps its id — other tables may reference it. The
            // declared id is only ever used for fresh inserts.
            sourceRecord = { ...sourceRecord, id: existingRecord.id };
          }

          if (existingRecord.isLoadedFromSource !== true) {
            // A runtime-created row holding the declaration's OWN id (natural-key tables never
            // reach here — refused above) is being taken over by that declaration — deliberate,
            // but loud: a declaration asserts ownership of the row's identity.
            adoptedCount += 1;
            this.logger.info({
              message: `(${table.name}) Adopting existing record into source ownership`,
              obj: { ...this.keyQuery(syncKey, sourceRecord), id: existingRecord.id },
            });
          } else if (reclaimedSoftRemoved) {
            // A soft-removed row re-claimed by its declaration under a changed natural key:
            // adopted in place and reactivated from the declaration by the update below.
            adoptedCount += 1;
            this.logger.info({
              message: `(${table.name}) Adopting soft-removed record re-declared under a changed ${syncKey.key}`,
              obj: {
                id: existingRecord.id,
                [`removed_${syncKey.key}`]: (existingRecord as any)[syncKey.key],
                ...this.keyQuery(syncKey, sourceRecord),
              },
            });
          } else {
            // THE PRECEDENCE on a row the sync owns (see load's ownership model).
            const authorship = await this.authorship(table, sourceRecord, existingRecord);
            if (authorship.verdict === 'kept') {
              keptCount += 1;
              new SourceRecordRepo().loadSourceRecord(table.name, existingRecord);
              continue;
            }
            if (authorship.verdict === 'diverged') {
              divergedCount += 1;
              this.logger.warn({
                message: `(${table.name}) Diverged on both sides since the last sync: the row holding ${this.keyWords(syncKey, sourceRecord)} was edited by the product and its declaration '${name}' moved as well — the row is left untouched (row digest ${authorship.rowDigest}, declaration digest ${authorship.declarationDigest})`,
                obj: {
                  declaration: qualifiedName,
                  ...this.keyQuery(syncKey, sourceRecord),
                  id: existingRecord.id,
                  rowDigest: authorship.rowDigest,
                  declarationDigest: authorship.declarationDigest,
                },
              });
              new SourceRecordRepo().loadSourceRecord(table.name, existingRecord);
              continue;
            }
            if (authorship.verdict === 'readopted') {
              // The declaration caught up with the product's edit: the row is the declaration's
              // again — stamped, nothing else written (every declared column already equals).
              adoptedCount += 1;
              this.logger.info({
                message: `(${table.name}) Re-adopting a product-edited record whose declaration now equals it`,
                obj: { ...this.keyQuery(syncKey, sourceRecord), id: existingRecord.id },
              });
            }
          }

          sourceRecord.declarationStamp = await this.stampFor(table, sourceRecord, declaredColumns);
          if (await this.hasChanges(table, sourceRecord, existingRecord)) {
            await db.update(table, sourceRecord);
            updateCount += 1;
          } else {
            unchangedCount += 1;
          }
        } else {
          sourceRecord.declarationStamp = await this.stampFor(table, sourceRecord, declaredColumns);
          const dbSourceRecord = await db.insert(table, sourceRecord);
          sourceRecord = { ...sourceRecord, ...dbSourceRecord };
          insertCount += 1;
        }

        // Registered under the DB id (= the adopted id when an existing row matched by natural key).
        new SourceRecordRepo().loadSourceRecord(table.name, sourceRecord as any);
      }

      const unowned = await this.countUnowned(db, table, syncKey);
      summary[table.name] = {
        inserts: insertCount,
        updates: updateCount,
        unchanged: unchangedCount,
        adopted: adoptedCount,
        refused: refusedCount,
        deletes: removed.deleteCount,
        removedUpdates: removed.removedUpdateCount,
        skippedNewer,
        unowned,
        kept: keptCount,
        diverged: divergedCount,
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
   * <build's declared keys for the table>` — the pair, in memory, when the key is scoped —
   * minus rows stamped by a newer version of their package, minus PRODUCT-AUTHORED rows: edited
   * by the product since the sync wrote them, kept whatever the declaration says) are handled
   * per the table's `onSourceRemoved` policy — delete (default), keep, or update with a patch.
   * The update leg applies the patch only to rows whose fields actually differ (idempotent
   * boots), through `Db.update` so table watchers observe each write, and re-stamps the row as
   * the sync's own write. The removal guard (`sourceRecordOptions.maxRemovedFraction`) refuses
   * the whole load of the table before anything is removed. See {@link load} for the ownership
   * model.
   */
  private async reconcileRemoved(
    db: Db,
    table: Table<any>,
    syncKey: SyncKey,
    buildSources: Set<string>,
    declaredKeyValues: unknown[],
    declaredKeys: Set<string>
  ): Promise<{ deleteCount: number; removedUpdateCount: number; skippedNewer: number; keptCount: number }> {
    const none = { deleteCount: 0, removedUpdateCount: 0, skippedNewer: 0, keptCount: 0 };
    const policy = table.sourceRecordOptions.onSourceRemoved ?? 'delete';
    if (policy === 'keep' || buildSources.size == 0) {
      return none;
    }

    const qb = QueryBuilder.fromObject<SourceRecord>({ isLoadedFromSource: true }, table.name);
    qb.condition({ field: 'sourcePackage', operator: 'IN', value: Array.from(buildSources) as any });
    if (syncKey.scope === undefined && declaredKeyValues.length > 0) {
      qb.condition({ field: syncKey.key as any, operator: 'NOT IN', value: declaredKeyValues as any });
    }

    let candidates: SourceRecord[] = await db.query(table, qb);
    if (syncKey.scope !== undefined) {
      // A scoped key is a pair: the exclusion is by (scope, key), which no single NOT IN says.
      candidates = candidates.filter((candidate) => !declaredKeys.has(this.keyText(syncKey, candidate)));
    }
    const stampedNewer = (candidate: SourceRecord) =>
      this.isNewerStamp(candidate.sourcePackageVersion, this.sourceVersion(candidate.sourcePackage as string));
    const reconcilable = candidates.filter((candidate) => !stampedNewer(candidate));
    const skippedNewer = candidates.length - reconcilable.length;
    if (skippedNewer > 0) {
      this.logger.info({
        message: `(${table.name}) Left ${skippedNewer} record${skippedNewer == 1 ? '' : 's'} stamped by a newer version of ${skippedNewer == 1 ? 'its' : 'their'} package — not treated as removed`,
        obj: { keys: candidates.filter(stampedNewer).map((candidate) => this.keyText(syncKey, candidate)) },
      });
    }

    const removedRecords: SourceRecord[] = [];
    let keptCount = 0;
    for (const candidate of reconcilable) {
      if (await this.rowMoved(table, candidate)) {
        keptCount += 1;
      } else {
        removedRecords.push(candidate);
      }
    }

    if (removedRecords.length == 0) {
      return { ...none, skippedNewer, keptCount };
    }

    if (policy === 'delete') {
      await this.guardRemoval(db, table, buildSources, removedRecords.length);
      const deleteQb = QueryBuilder.fromObject<SourceRecord>({ isLoadedFromSource: true }, table.name);
      deleteQb.condition({ field: 'id', operator: 'IN', value: removedRecords.map((record) => record.id) });
      return { deleteCount: await db.delete(table, deleteQb), removedUpdateCount: 0, skippedNewer, keptCount };
    }

    // A soft-removed row stays on the table (still loaded from source, still the sync's), so it
    // is a candidate on every later boot. What this boot REMOVES is only what the patch would
    // still change: the guard counts those, never the rows an earlier boot already patched —
    // else the second single removal on a table would read as "2 of 3" and refuse every boot.
    const unpatched: SourceRecord[] = [];
    for (const removedRecord of removedRecords) {
      if (await this.hasChanges(table, policy.update, removedRecord)) {
        unpatched.push(removedRecord);
      }
    }
    await this.guardRemoval(db, table, buildSources, unpatched.length);

    let removedUpdateCount = 0;
    for (const removedRecord of unpatched) {
      // The patch is the sync's own write: the stamp follows it, over the columns the row was
      // stamped with plus the patch's, so the row stays declaration-authored.
      const patched = { ...removedRecord, ...policy.update };
      const stampedColumns = removedRecord.declarationStamp
        ? SourceRecordStamp.columnsOf(removedRecord.declarationStamp) ?? []
        : [];
      const columns = [...stampedColumns, ...SourceRecordStamp.declaredColumnNames(table, policy.update)];
      const declarationStamp = await this.stampFor(table, patched, columns);
      await db.update(table, { id: removedRecord.id, ...policy.update, declarationStamp });
      removedUpdateCount += 1;
      this.logger.info({
        message: `(${table.name}) Applied onSourceRemoved update to record removed from source`,
        obj: {
          id: removedRecord.id,
          ...this.keyQuery(syncKey, removedRecord),
          source: removedRecord.sourcePackage,
        },
      });
    }

    return { deleteCount: 0, removedUpdateCount, skippedNewer, keptCount };
  }

  /**
   * The removal guard: refuse before anything is removed when the removal would take more than
   * the table's named fraction of the declaration-authored rows this build owns on it (the
   * rows this reconcile speaks for: `is_loaded_from_source = true AND source_package IN
   * <build's packages>`, whatever they hold) — and more than one row.
   */
  private async guardRemoval(db: Db, table: Table<any>, buildSources: Set<string>, removing: number): Promise<void> {
    const maxRemovedFraction = table.sourceRecordOptions.maxRemovedFraction ?? 0.5;
    if (removing <= 1 || maxRemovedFraction >= 1) {
      return;
    }

    const ownedQb = QueryBuilder.fromObject<SourceRecord>({ isLoadedFromSource: true }, table.name);
    ownedQb.condition({ field: 'sourcePackage', operator: 'IN', value: Array.from(buildSources) as any });
    const owned = await db.getRowCount(table, ownedQb);
    if (removing > maxRemovedFraction * owned) {
      throw new SourceRecordRemovalRefusedError(table.name, removing, owned, maxRemovedFraction);
    }
  }

  /**
   * The widened adoption match for tables that SOFT-remove (keep rows on removal via the
   * `onSourceRemoved` update policy): a declaration whose natural key matched nothing may still
   * be a RE-declaration of a removed-and-kept row — the same stable declared id under a changed
   * natural key (e.g. a machine account renamed while decommissioned). Without this, the insert
   * leg collides with the kept row's primary key and the boot fails.
   *
   * Returns the soft-removed row the declaration re-claims, or undefined. The match is
   * deliberately strict — all of:
   * - the table keeps removed rows (`onSourceRemoved` is an update patch — soft removal);
   * - the declaration CARRIES an id (a declaration file's rows never do — its key is the
   *   natural key, and a row it lists again is matched by that key alone; claiming by an
   *   absent id is no claim, never a query on `id = undefined`);
   * - a row holds the DECLARED id;
   * - that row is source-owned (`is_loaded_from_source = true`) by THIS declaration's package
   *   (never adopt a human/runtime row, or another package's row, by id), and still as the sync
   *   left it (a kept row the product edited since is the product's — see {@link load});
   * - no declaration in this build claims the row by natural key (it is a removed row, not a
   *   duplicate-id declaration — that case still fails the boot loudly at insert).
   *
   * The caller then reactivates the row by re-deriving every declared field from the current
   * declaration (natural key included) through the normal drift-reversion update — declaration
   * is the source of truth, so nothing removed-era (grants, status, natural key) survives
   * re-adoption; runtime-owned fields the declaration never emits are untouched. The version
   * guard is the caller's existing stamped-newer branch, which applies to the returned row
   * verbatim (same package by construction).
   *
   * This is the one-off form of a future generic `softRemoval` hook (adopt-including-removed +
   * reactivate-from-declaration): graduating it means lifting this method behind a table-level
   * seam, not rewriting the semantics. The contract lives on
   * {@link SourceRecordOptions.onSourceRemoved}.
   */
  private async softRemovedRecordHoldingDeclaredId(
    db: Db,
    table: Table<any>,
    syncKey: SyncKey,
    declaredId: string | undefined,
    source: string,
    declaredKeys: Set<string>
  ): Promise<SourceRecord | undefined> {
    const policy = table.sourceRecordOptions.onSourceRemoved;
    if (typeof policy !== 'object' || declaredId === undefined) {
      return undefined;
    }

    const holder: SourceRecord | undefined = await db.get(table, { id: declaredId });
    if (
      !holder ||
      holder.isLoadedFromSource !== true ||
      holder.sourcePackage !== source ||
      declaredKeys.has(this.keyText(syncKey, holder)) ||
      (await this.rowMoved(table, holder))
    ) {
      return undefined;
    }

    return holder;
  }

  /**
   * Source-loaded rows with no owner stamp that no declaration in this build claimed on this
   * boot (the stamp leg has already run). They predate `source_package`, or their declaring
   * package is not in this build; nobody prunes them. Reported so they are visible, never acted
   * on. Tables that keep removed rows (`onSourceRemoved: 'keep'`) opted out of removal
   * semantics altogether, so there is nothing to explain there.
   */
  private async countUnowned(db: Db, table: Table<any>, syncKey: SyncKey): Promise<number> {
    if ((table.sourceRecordOptions.onSourceRemoved ?? 'delete') === 'keep') {
      return 0;
    }

    const qb = QueryBuilder.fromObject<SourceRecord>({ isLoadedFromSource: true }, table.name);
    qb.condition({ field: 'sourcePackage', operator: 'IS NULL' });
    const unowned: SourceRecord[] = await db.query(table, qb);
    if (unowned.length > 0) {
      this.logger.warn({
        message: `(${table.name}) ${unowned.length} source-loaded ${unowned.length == 1 ? 'record has' : 'records have'} no owning package and no declaration in this build — left untouched`,
        obj: { keys: unowned.map((record) => this.keyText(syncKey, record)) },
      });
    }

    return unowned.length;
  }

  /**
   * Resolve and validate the property the sync keys on: `id` unless the table declares
   * `sourceRecordOptions.naturalKey`. A natural key must be schema-unique (a `ColumnOptions.unique`
   * column or a single-column unique index in `Table.indexes` — or, when
   * `sourceRecordOptions.naturalKeyScope` scopes it, a unique index over exactly the scope column
   * and the key), present on every declaration (the scope too), and unambiguous across
   * declarations (within one scope value, when scoped) — each violation fails boot loudly by name.
   */
  private validateSyncKey(table: Table<any>, records: Omit<SourceRecord, 'created' | 'updated'>[]): SyncKey {
    const naturalKey = table.sourceRecordOptions.naturalKey;
    const scope = table.sourceRecordOptions.naturalKeyScope;
    if (!naturalKey) {
      if (scope) {
        throw new Error(`(${table.name}) sourceRecordOptions.naturalKeyScope '${scope}' needs a naturalKey to scope`);
      }
      return { key: 'id' };
    }

    const column = (table.columns as any)[naturalKey];
    if (!column) {
      throw new Error(
        `(${table.name}) sourceRecordOptions.naturalKey '${naturalKey}' is not a column property on the table`
      );
    }
    if (scope !== undefined && !(table.columns as any)[scope]) {
      throw new Error(
        `(${table.name}) sourceRecordOptions.naturalKeyScope '${scope}' is not a column property on the table`
      );
    }

    const indexOver = (columns: string[]) =>
      (table.indexes ?? []).some(
        (index) =>
          index.unique === true &&
          index.columns.length === columns.length &&
          [...index.columns.map(String)].sort().join(',') === [...columns].sort().join(',')
      );
    if (scope === undefined) {
      const uniqueByColumn = column.options?.unique?.unique === true;
      if (!uniqueByColumn && !indexOver([naturalKey])) {
        throw new Error(
          `(${table.name}) sourceRecordOptions.naturalKey '${naturalKey}' requires the column to be unique — ` +
            `declare ColumnOptions.unique on it (or a single-column unique index in Table.indexes) so ` +
            `natural-key adoption cannot match ambiguously`
        );
      }
    } else if (!indexOver([scope, naturalKey])) {
      throw new Error(
        `(${table.name}) sourceRecordOptions.naturalKey '${naturalKey}' scoped by '${scope}' requires a unique index ` +
          `over exactly [${scope}, ${naturalKey}] in Table.indexes so the scoped key cannot match ambiguously`
      );
    }

    const syncKey: SyncKey = scope === undefined ? { key: naturalKey } : { key: naturalKey, scope };
    const seen = new Map<string, true>();
    for (const record of records) {
      for (const property of scope === undefined ? [naturalKey] : [scope, naturalKey]) {
        const value = (record as any)[property];
        if (value === undefined || value === null) {
          throw new Error(
            `(${table.name}) A source record declaration is missing its ${property === scope ? 'natural key scope' : 'natural key'} '${property}' (declared id: '${record.id}')`
          );
        }
      }

      const text = this.keyText(syncKey, record);
      if (seen.has(text)) {
        throw new Error(
          `(${table.name}) Two source record declarations share the natural key ${this.keyWords(syncKey, record)} — ` +
            `declarations must be unique by natural key${scope === undefined ? '' : ' within a scope'}`
        );
      }

      seen.set(text, true);
    }

    return syncKey;
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
   *
   * The version stamp (`source_package_version`) is bookkeeping, not definition: it names the
   * version that last WROTE the row and rides every source record (every release bumps the
   * declaring package), so comparing it would rewrite every row on every release — the churn
   * that bumped `updated` on migration ledger rows nobody had touched. A stamped row's version
   * is therefore never drift by itself; it moves only when a genuine change rewrites the row.
   * A row with NO stamp (written before versions existed, or by a build that could not resolve
   * its version) still gets one — once — so version ordering can protect it from then on.
   */
  private async hasChanges(table: Table<any>, sourceRecord: any, existingRecord: any): Promise<boolean> {
    const serializer = new RecordSerializer(table);
    const serializedSource = await serializer.serialize(sourceRecord);
    const serializedExisting = await serializer.serialize(existingRecord);
    const versionStampColumn: string | undefined = (table.columns as any).sourcePackageVersion?.name;
    for (const columnName in serializedSource) {
      if (columnName === 'id' || columnName === 'created' || columnName === 'updated') {
        continue;
      }

      if (columnName === versionStampColumn && serializedExisting[columnName] != null) {
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
   * Every source-record table in this build with the records declared for it — from code and
   * from declaration files — plus the set of packages that declare ANY source record in this
   * build — the packages this boot speaks for.
   */
  private async getDeclarations(): Promise<{ tables: SourceRecordsMap; buildSources: Set<string> }> {
    const tables: SourceRecordsMap = {};
    for (const table of getSourceRecordTables()) {
      tables[table.name] = { table, records: [] };
    }

    const buildSources = new Set<string>();
    for (const { source, qualifiedName, name, loader } of getSourceRecordLoaders()) {
      buildSources.add(source);
      if (!tables[loader.table.name]) {
        tables[loader.table.name] = { table: loader.table, records: [] };
      }

      tables[loader.table.name].records.push({ source, qualifiedName, name, record: loader.record });
    }

    // Declaration FILES — the other declaration source: every row of the document is a record
    // declared by the file's package, under the file's own name (what `source-records pull`
    // wrote; see SourceRecordDeclarationDocument for the format and its validation). An
    // external column's sibling files are read relative to the document.
    for (const { source, qualifiedName, name, declarationFile } of getSourceRecordDeclarationFiles()) {
      buildSources.add(source);
      const { table } = declarationFile;
      if (!tables[table.name]) {
        tables[table.name] = { table, records: [] };
      }

      const document = SourceRecordDeclarationDocument.parse(
        fs.readFileSync(declarationFile.path, 'utf8'),
        declarationFile.path
      );
      const directory = path.dirname(declarationFile.path);
      const records = await SourceRecordDeclarationDocument.toRecords(table, document, (relativePath) =>
        fs.readFileSync(path.join(directory, relativePath), 'utf8')
      );
      for (const record of records) {
        tables[table.name].records.push({ source, qualifiedName, name, record });
      }
    }

    return { tables, buildSources };
  }

  /**
   * Whose row an existing, owned row is — the sync's stamp against the row as it stands and
   * against the declaration as it stands (see {@link Authorship} and load's ownership model). A
   * row with no stamp predates stamps: the sync owned it then and still does.
   */
  private async authorship(table: Table<any>, declaredRecord: any, existingRecord: SourceRecord): Promise<Authorship> {
    const stamp = existingRecord.declarationStamp;
    if (stamp == null) {
      return { verdict: 'declaration' };
    }

    const serializer = new RecordSerializer(table);
    const row = await serializer.serialize(this.withoutStamps(existingRecord));
    if (SourceRecordStamp.matches(stamp, row)) {
      return { verdict: 'declaration' };
    }

    // The row moved since the sync wrote it. The declaration caught up with it → re-adopted.
    if (!(await this.hasChanges(table, this.withoutStamps(declaredRecord), existingRecord))) {
      return { verdict: 'readopted' };
    }

    // The declaration did not move → the product's, one-sided. Both moved → diverged.
    const declaration = await serializer.serialize(this.withoutStamps(declaredRecord));
    if (SourceRecordStamp.matches(stamp, declaration)) {
      return { verdict: 'kept' };
    }

    return {
      verdict: 'diverged',
      rowDigest: SourceRecordStamp.digestOver(stamp, row) as string,
      declarationDigest: SourceRecordStamp.digestOver(stamp, declaration) as string,
    };
  }

  /** Whether an owned row's declared columns moved since the sync wrote it (its stamp no longer matches). */
  private async rowMoved(table: Table<any>, existingRecord: SourceRecord): Promise<boolean> {
    if (existingRecord.isLoadedFromSource !== true || existingRecord.declarationStamp == null) {
      return false;
    }

    const serialized = await new RecordSerializer(table).serialize(this.withoutStamps(existingRecord));
    return !SourceRecordStamp.matches(existingRecord.declarationStamp, serialized);
  }

  /** The stamp for a record as the sync is about to write it, over the given column names. */
  private async stampFor(table: Table<any>, record: any, columnNames: string[]): Promise<string> {
    const serialized: SerializedRecord = await new RecordSerializer(table).serialize(this.withoutStamps(record));
    return SourceRecordStamp.render(serialized, columnNames);
  }

  /** The record minus the sync's own stamps — what a declaration and a row are compared on. */
  private withoutStamps<T extends object>(record: T): T {
    const copy: any = { ...record };
    delete copy.isLoadedFromSource;
    delete copy.sourcePackage;
    delete copy.sourcePackageVersion;
    delete copy.declarationStamp;
    return copy;
  }

  /** The query that matches a record's row by the sync key — the (scope, key) pair when scoped. */
  private keyQuery(syncKey: SyncKey, record: any): { [property: string]: unknown } {
    return syncKey.scope === undefined
      ? { [syncKey.key]: record[syncKey.key] }
      : { [syncKey.scope]: record[syncKey.scope], [syncKey.key]: record[syncKey.key] };
  }

  /** One text per key value (the pair when scoped) — for membership and for log lines. */
  private keyText(syncKey: SyncKey, record: any): string {
    return JSON.stringify(
      syncKey.scope === undefined ? [record[syncKey.key]] : [record[syncKey.scope], record[syncKey.key]]
    );
  }

  /** The key named for a message: `'email' = 'x'`, or `'scope' = 'a', 'skillId' = 'x'` when scoped. */
  private keyWords(syncKey: SyncKey, record: any): string {
    const word = (property: string) => `'${property}' = '${record[property]}'`;
    return syncKey.scope === undefined ? word(syncKey.key) : `${word(syncKey.scope)}, ${word(syncKey.key)}`;
  }

  /**
   * Find the first point of divergence between source and existing values.
   * Returns a description of the mismatch path, or null if they match.
   *
   * For object-valued fields (e.g. a `JsonColumn` blob), source is treated as
   * fully authoritative: any structural drift — extra keys in existing, missing
   * keys in existing, or value differences anywhere in the subtree — produces
   * a mismatch. Comparison goes through {@link SourceRecordSyncRunner.canonicalStringify}
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
    // Mirror JSON.stringify: a Date is its ISO text — never an object with no own keys, which
    // would read every two dates as equal (a serialized DateTimeColumn value IS a Date; the
    // stamp's digest reads dates the same way, `SourceRecordStamp.canonical`).
    if (value instanceof Date) {
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
   * declare records, so module-relative resolution could never find them).
   *
   * Two roads, in order:
   * 1. The booting package itself: `<cwd>/package.json`, when its `name` is `source`. A lookup by
   *    name from cwd searches cwd's node_modules chain, which never contains the package cwd IS,
   *    so without this read the server's own records would sync unversioned.
   * 2. Any other package: its entry is resolved from cwd (honoring exports maps, where
   *    `<pkg>/package.json` is usually not requireable), then the nearest package.json whose
   *    `name` matches is read walking up from it.
   *
   * Returns undefined where neither road resolves — a package not resolvable from cwd. The sync
   * then has no place in the version order for that package: it never touches its
   * version-stamped rows, and what it writes is unversioned (see {@link isNewerStamp}). Logged
   * once per boot so a misconfigured cwd is visible.
   *
   * Plain Node here — `fs`, `path` and the CJS `require.resolve` — because this module is
   * server-only code behind the `@proteinjs/db/source` subpath: the package's browser index never
   * imports it (test/BrowserIndexNoNodeBuiltins.test.ts holds that line), so nothing here hides
   * from a bundler.
   */
  private resolveSourceVersion(source: string): string | undefined {
    const cwd = process.cwd();
    try {
      const ownVersion = this.packageVersionAt(path.join(cwd, 'package.json'), source);
      if (ownVersion) {
        return ownVersion;
      }

      const entryPath = require.resolve(source, { paths: [cwd] });
      // Walk up from the entry file to the package's own package.json (the name check skips
      // nested stubs like a dist/package.json); stop at the filesystem root.
      for (let directory = path.dirname(entryPath); ; directory = path.dirname(directory)) {
        const version = this.packageVersionAt(path.join(directory, 'package.json'), source);
        if (version) {
          return version;
        }

        if (path.dirname(directory) === directory) {
          break;
        }
      }
    } catch {
      // Unresolvable from cwd — reported below.
    }

    this.logger.warn({
      message: `Could not resolve a version for source package '${source}' from '${cwd}' — its records sync without version ordering (this build never touches its version-stamped rows)`,
    });
    return undefined;
  }

  /** The `version` of the package.json at `packageJsonPath` when it exists and names `source`. */
  private packageVersionAt(packageJsonPath: string, source: string): string | undefined {
    if (!fs.existsSync(packageJsonPath)) {
      return undefined;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return packageJson?.name === source && typeof packageJson.version === 'string' ? packageJson.version : undefined;
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
