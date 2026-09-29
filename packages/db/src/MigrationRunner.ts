import { Moment, moment } from './opt/moment';
import { Db, getDb, getDbAsSystem } from './Db';
import { Table } from './Table';
import { SourceRecordRepo } from './source/SourceRecordRepo';
import { SourceRecordSyncRunner } from './source/SourceRecordSyncRunner';
import { getSourceRecordLoaders } from './source/SourceRecord';
import { MigrationRunnerService, getMigrationRunnerService } from './services/MigrationRunnerService';
import { Migration, MigrationEstimate, MigrationTable } from './tables/MigrationTable';
import { QueryBuilderFactory } from './QueryBuilderFactory';
import { TableManager } from './schema/TableManager';
import { Service } from '@proteinjs/service';
import { Logger } from '@proteinjs/logger';

export const getMigrationRunner = () =>
  typeof self === 'undefined' ? new MigrationRunner() : (getMigrationRunnerService() as MigrationRunner);

/**
 * What one deploy-gated series run did (plans/POST_RELEASE_QUEUE.md 27f). Ids appear in ledger
 * order (oldest-first). The caller's gate is `failed`: present → the series stopped there, the
 * deploy Job must exit non-zero, the rollout must not advance.
 */
export interface MigrationSeriesSummary {
  /** Ran to success in this series. */
  applied: string[];
  /** Excluded by the explicit `manual` flag (they keep the Migrations-page flow). */
  skippedManual: string[];
  /** Already in 'success' status — skipped (ensureMigrationRun's idempotence). */
  alreadyApplied: string[];
  /**
   * Ledger rows with no source record (a loader deleted after its run; the table keeps history) —
   * each one is STAMPED `retired: true` by this run, so a source class that ships again later can
   * never silently re-arm it.
   */
  unresolved: string[];
  /**
   * Rows that arrived already `retired: true` — never auto-run, even when the source class ships
   * again, until someone un-retires them on the Migrations page.
   */
  retired: string[];
  /** The failure that stopped the series, if any. */
  failed?: { id: string; description: string; failureMessage?: string };
  /** Ordered after the failure — never started (later migrations may build on earlier ones). */
  notAttempted: string[];
}

/**
 * The plan for the pending series, read BEFORE anything runs: each pending migration's estimate
 * ({@link Migration.estimate}) and the projection over the ones that declared seconds per unit.
 * {@link MigrationRunner.planPendingMigrations} returns it without applying anything (the dry
 * run); {@link MigrationRunner.runPendingMigrations} logs it before its first run. Ids appear in
 * the order the series would run them.
 */
export interface MigrationPlan {
  /** The migrations the series would run, in order, each with its estimate when declared. */
  pending: MigrationPlanEntry[];
  /** Seconds projected over the entries that declared `secondsPerUnit` — the deadline's input. */
  projectedSeconds: number;
  /** How many entries the projection covers. */
  projected: number;
  /** Ids the projection does NOT cover: no estimate declared, or no seconds per unit. */
  unprojected: string[];
  /** Excluded by the explicit `manual` flag. */
  skippedManual: string[];
  /** Already in 'success' status. */
  alreadyApplied: string[];
  /** Ledger rows with no source record in this build (the run stamps these retired; the plan only reports). */
  unresolved: string[];
  /** Rows carrying `retired: true`. */
  retired: string[];
  /**
   * True when the ledger table does not exist: a database no schema sync has touched, so every
   * declared migration runs over empty tables — the estimates are not read (nothing to count).
   */
  freshDatabase: boolean;
}

export interface MigrationPlanEntry {
  id: string;
  description: string;
  /**
   * Runs during `Db.init()` before schema sync rather than in the series
   * ({@link Migration.preSchemaSync}) — planned all the same: a deploy's deadline covers init.
   */
  preSchemaSync?: boolean;
  estimate?: MigrationEstimate;
  /** `ceil(units × secondsPerUnit)` when the estimate declares seconds per unit. */
  projectedSeconds?: number;
  /** Why the entry carries no projection, in the words the plan line uses. */
  unprojectedReason?: string;
}

/** The classification of a ledger row against this build's source declarations. */
interface LedgerClassification {
  /** The source declarations that would run, in series order. */
  pending: Migration[];
  skippedManual: string[];
  alreadyApplied: string[];
  unresolved: string[];
  retired: string[];
}

export class MigrationRunner implements MigrationRunnerService {
  private logger = new Logger({ name: this.constructor.name });
  public serviceMetadata: Service['serviceMetadata'] = {
    // Running migrations rides the abstract 'dev' PERMISSION (the developer-surface slug the
    // db-ui dev pages also declare), resolved through the consumer app's PermissionRolesMapping.
    // Admin still passes as break-glass. Matches the migration table's doors below the service.
    auth: {
      permission: 'dev',
    },
    doNotAwait: true,
  };

  /**
   * The service dispatches this fire-and-forget (`doNotAwait`). The method is split along that
   * seam: everything knowable before the run starts (a bogus id) throws synchronously — the only
   * path on which an error can still reach the client (the executor wraps it into a
   * ServiceError -> 400). The returned promise MAY REJECT (infrastructure failure while recording
   * run state); the caller owns that rejection — on the service path the executor terminally
   * observes every doNotAwait rejection (logs with method identity, never process death).
   */
  runMigration(id: string): Promise<void> {
    const migrationTable: Table<Migration> = new MigrationTable();
    const migration = this.resolveMigration(migrationTable, id);
    return this.runAndRecord(migrationTable, migration, getDb);
  }

  /**
   * Boot-path API: at server boot no user session exists, so `getDb()` (which `runMigration`
   * records through) fail-closes on the migration table's doors. This method reads and records
   * run state through `getDbAsSystem()` instead — it is the seam a future migrations-auto-run
   * rides (deploy-coupled migrations call it during server startup).
   *
   * 'ensure' = idempotent: a row already in 'success' status is logged and skipped. A prior
   * 'failure' row is retried by design — a fixed migration should run on the next boot.
   *
   * Returns the migration with its final run state (the skipped row, or the run's outcome) —
   * the series runner ({@link runPendingMigrations}) gates on it.
   */
  async ensureMigrationRun(id: string): Promise<Migration> {
    const migrationTable: Table<Migration> = new MigrationTable();
    const db = getDbAsSystem();
    const migrationRow = await db.get(migrationTable, { id });
    if (migrationRow?.status === 'success') {
      this.logger.info({ message: `Migration (${id}) already applied, skipping` });
      return migrationRow;
    }

    const migration = this.resolveMigration(migrationTable, id);
    await this.runAndRecord(migrationTable, migration, () => db);
    return migration;
  }

  /**
   * Pre-schema-sync phase — called by {@link Db.init} between database creation and schema sync:
   * runs every source-declared migration flagged {@link Migration.preSchemaSync}, so data repairs
   * a new schema invariant depends on (e.g. deduplicating rows a new unique index would reject —
   * TableManager's unique-index preflight fails loudly over violating data) land BEFORE the DDL
   * that needs them. The ordinary series ({@link runPendingMigrations}) runs after init — too
   * late for this class by construction.
   *
   * ZERO-COST WHEN UNUSED: no flagged migrations -> immediate return (no ledger IO, no DDL) —
   * the common boot pays nothing.
   *
   * Bootstrap: the phase runs before schema sync, so it fronts the two pieces it needs itself —
   * the migration TABLE's own schema (framework-owned, never data-hazardous) and the migration
   * table's source-record sync (ledger rows + SourceRecordRepo registration, which
   * {@link ensureMigrationRun}'s resolveMigration reads). The full loadTables/source sync that
   * follows re-reconciles both idempotently.
   *
   * Runs through {@link ensureMigrationRun} — full ledger semantics: skip on 'success', retry on
   * 'failure'/'running' (a crashed earlier boot). Multiple flagged migrations run in series
   * ordered by id (deterministic; their ledger rows may not exist yet, so created-order cannot
   * apply). A non-success outcome THROWS: Db.init must fail as loudly as the schema sync it
   * protects would have — the boot crash / deploy-Job failure names the migration instead of an
   * opaque index-backfill error, and the recorded failure row retries on the next boot.
   */
  async runPreSchemaSyncMigrations(tableManager: TableManager): Promise<void> {
    const migrationTable: Table<Migration> = new MigrationTable();
    const flagged = getSourceRecordLoaders<Migration>()
      // db >=1.34.4: declarations are { source, loader } pairs — the loader carries table/record.
      .filter(({ loader }) => loader.table.name === migrationTable.name && (loader.record as Migration).preSchemaSync)
      .map(({ loader }) => loader.record as Migration)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (flagged.length === 0) {
      return;
    }

    const contradictions = flagged.filter((migration) => migration.manual);
    if (contradictions.length > 0) {
      throw new Error(
        `Migration(s) declare both preSchemaSync and manual — a contradiction (the pre-schema-sync phase ` +
          `exists to run unattended before DDL): ${contradictions.map((migration) => migration.id).join(', ')}`
      );
    }

    await tableManager.loadTable(migrationTable);
    await new SourceRecordSyncRunner().load(migrationTable);
    this.logger.info({
      message: `Running ${flagged.length} pre-schema-sync migration${flagged.length === 1 ? '' : 's'} before schema sync`,
      obj: { ids: flagged.map((migration) => migration.id) },
    });
    for (const migration of flagged) {
      const outcome = await this.ensureMigrationRun(migration.id);
      if (outcome.status !== 'success') {
        throw new Error(
          `Pre-schema-sync migration (${outcome.id}) failed; schema sync not attempted: ${outcome.failureMessage}`
        );
      }
    }
  }

  /**
   * Deploy-path API (plans/POST_RELEASE_QUEUE.md 27f): the deploy pipeline's migration Job calls
   * this AFTER `new Db().init()` (schema sync + source-record sync — every source-declared
   * migration has a ledger row by then) and BEFORE the rollout advances. Pod boot never calls it:
   * boot stays migration-free (the startupProbe invariant — DbInitStartupTask is schema sync and
   * source records only).
   *
   * Discovery + order: the migration LEDGER (the migration table) is the authority. Rows run in
   * SERIES, oldest-first by the row's `created` (id tiebreak) — a migration that shipped in an
   * earlier release always runs before a later one. Never parallel.
   *
   * Policy:
   * - `manual: true` (the source record's declaration) is EXCLUDED — the explicit non-automatable
   *   class keeps the Migrations-page flow ({@link Migration.manual}).
   * - rows already in 'success' are skipped; any other status is pending — including 'running'
   *   (a crashed earlier Job): {@link ensureMigrationRun} re-runs it.
   * - rows with no source record are history (a loader deleted after its run) — STAMPED
   *   `retired: true`, skipped, reported as `unresolved`.
   * - rows with `retired: true` are NEVER auto-run — even if the source class returns in a later
   *   build — until un-retired on the Migrations page; skipped, reported as `retired`.
   * - the FIRST failure STOPS the series (later migrations may build on earlier ones). The
   *   caller exits non-zero, the Job fails, the rollout does not advance.
   * - the PLAN comes first: before the first run, every pending migration's estimate
   *   ({@link Migration.estimate}) is logged as one line and the series' total as another — the
   *   same lines {@link planPendingMigrations} produces on its own for a dry run.
   *
   * EXPAND-CONTRACT INVARIANT (documented at this seam on purpose): every automated migration —
   * and the schema sync that fronts it — must be backward-compatible with the STILL-RUNNING old
   * release, because the old pods keep serving while this runs and keep serving indefinitely if
   * it fails. "Roll back" = do not advance the code; DDL and applied migrations are never
   * un-applied (Spanner DDL is not transactional-reversible). Contractions (drops, rewrites that
   * break the old reader) belong in the `manual` class, run only after every consumer of the old
   * shape is gone.
   */
  async runPendingMigrations(): Promise<MigrationSeriesSummary> {
    const migrationTable: Table<Migration> = new MigrationTable();
    const db = getDbAsSystem();
    const ledger = await db.query(migrationTable, this.ledgerInSeriesOrder(migrationTable));
    const sourceRecordRepo = new SourceRecordRepo();
    const classified = this.classifyLedger(ledger, (id) =>
      sourceRecordRepo.getSourceRecord<Migration>(migrationTable.name, id)
    );
    for (const id of classified.unresolved) {
      // Stamp, don't just skip: the ledger must remember the source class was gone. If the
      // class ships again in a later build, the row stays excluded until a human un-retires it
      // on the Migrations page — a returned loader id is not consent to auto-run.
      await db.update(migrationTable, { id, retired: true } as Partial<Migration>);
    }

    const summary: MigrationSeriesSummary = {
      applied: [],
      skippedManual: classified.skippedManual,
      alreadyApplied: classified.alreadyApplied,
      unresolved: classified.unresolved,
      retired: classified.retired,
      notAttempted: [],
    };
    const pending = classified.pending;
    this.logger.info({
      message: `Running ${pending.length} pending migration${pending.length === 1 ? '' : 's'} in series, oldest-first`,
      obj: {
        pending: pending.map((migration) => migration.id),
        skippedManual: summary.skippedManual,
        skippedRetired: summary.retired,
        stampedRetired: summary.unresolved,
      },
    });
    // The plan, BEFORE the first run: every pending migration's estimate as one line, then the
    // total — the reader of the Job's log knows what the series is about to do and how long the
    // projection says it takes, before a row changes.
    await this.estimateSeries(pending, { ...classified, freshDatabase: false });
    for (let i = 0; i < pending.length; i++) {
      const outcome = await this.ensureMigrationRun(pending[i].id);
      if (outcome.status === 'success') {
        summary.applied.push(outcome.id);
        continue;
      }
      summary.failed = {
        id: outcome.id,
        description: outcome.description,
        failureMessage: outcome.failureMessage,
      };
      summary.notAttempted = pending.slice(i + 1).map((migration) => migration.id);
      break;
    }

    this.logger.info({ message: `Migration series finished`, obj: summary as any });
    return summary;
  }

  /**
   * The DRY RUN — the plan and nothing else: what {@link runPendingMigrations} would run, with
   * each migration's estimate ({@link Migration.estimate}, read-only by contract) and the
   * projection over the ones that declared seconds per unit. Applies NOTHING: no `Db.init()`
   * (the deploy entrypoint calls this INSTEAD of init — init would create the database, run the
   * pre-schema-sync migrations, sync the schema and sync the source records), no run, no ledger
   * write — an unresolved row is reported, not stamped.
   *
   * Runs before init by construction, so the declarations come from the BUILD (the reflection
   * source-record loaders for the migration table) joined to the ledger as it stands: a row's
   * status says whether its migration is pending; a declaration with no row yet is what this
   * release's source sync will insert as 'proposed' — pending, planned after the ledger's own
   * pending rows (their `created` is older than a row born at the next init), in id order among
   * themselves. Source records already registered in this process (init has run, or a test
   * planted them) take precedence over the build's declaration of the same id — the same object
   * after init.
   *
   * A database the schema sync has never touched has no ledger table: every declared migration
   * is listed, no estimate is read (their tables do not exist either — nothing to count), and
   * the plan says `freshDatabase`. An estimate that throws fails the plan loudly — a plan that
   * cannot count is not a plan.
   */
  async planPendingMigrations(): Promise<MigrationPlan> {
    const migrationTable: Table<Migration> = new MigrationTable();
    const db = getDbAsSystem();
    const declared = this.declaredMigrations(migrationTable);
    const sourceRecordRepo = new SourceRecordRepo();
    const sourceOf = (id: string) =>
      sourceRecordRepo.getSourceRecord<Migration>(migrationTable.name, id) ?? declared.get(id);
    const freshDatabase = !(await db.tableExists(migrationTable));
    const ledger = freshDatabase ? [] : await db.query(migrationTable, this.ledgerInSeriesOrder(migrationTable));
    const classified = this.classifyLedger(ledger, sourceOf);
    const inLedger = new Set(ledger.map((row) => row.id));
    const unsynced = Array.from(declared.values())
      .filter((migration) => !inLedger.has(migration.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const migration of unsynced) {
      if (migration.manual) {
        classified.skippedManual.push(migration.id);
      } else {
        classified.pending.push(migration);
      }
    }
    return await this.estimateSeries(classified.pending, { ...classified, freshDatabase });
  }

  // The db is taken as a provider, resolved inside this async body: on the service path,
  // constructing the Db is itself run infrastructure — its failure must REJECT the detached
  // promise, not throw synchronously from runMigration (only a bogus id may reach the client).
  private async runAndRecord(
    migrationTable: Table<Migration>,
    migration: Migration,
    getRunDb: () => Db
  ): Promise<void> {
    const db = getRunDb();
    migration.status = 'running';
    migration.startTime = moment();
    await db.update(migrationTable, this.definedFields(migration));
    this.logger.info({ message: `Running migration (${migration.id}) ${migration.description}` });
    try {
      migration.output = await migration.run();
      migration.status = 'success';
    } catch (error: any) {
      // Domain bookkeeping, not containment: a migration that throws is a run OUTCOME, recorded
      // as failure status on the record. Only infrastructure failures (the db.update calls
      // themselves) reject the returned promise.
      migration.failureMessage = error.message;
      migration.failureStack = error.stack;
      migration.status = 'failure';
    } finally {
      migration.endTime = moment();
    }
    migration.duration = this.duration(migration.startTime, migration.endTime);
    await db.update(migrationTable, this.definedFields(migration));
    this.logger.info({
      message: `[${migration.status}] (${migration.duration}) Finished running migration (${migration.id}) ${migration.description}`,
    });
  }

  /**
   * The run-state payload with `undefined`-valued fields OMITTED. Several of the record's fields
   * are legitimately absent depending on the run (`output` for a void `run()`, `failureMessage`/
   * `failureStack` for a non-Error throw), but the migration object carries them as explicit
   * `undefined` assignments — and `RecordSerializer` rejects any payload field holding `undefined`
   * (never a partial write), which would strand the row at 'running' status with the run's real
   * outcome lost. Absent means omitted, never undefined — for EVERY optional field of the payload,
   * not per-field.
   */
  private definedFields(migration: Migration): Partial<Migration> {
    const payload: Partial<Migration> = {};
    for (const [field, value] of Object.entries(migration)) {
      if (value !== undefined) {
        (payload as any)[field] = value;
      }
    }
    return payload;
  }

  private resolveMigration(migrationTable: Table<Migration>, id: string): Migration {
    const migration = new SourceRecordRepo().getSourceRecord<Migration>(migrationTable.name, id);
    if (!migration) {
      throw new Error(`Unable to find migration source record for id: ${id}`);
    }

    return migration;
  }

  private duration(start: Moment, end: Moment): string {
    const duration = moment.duration(end.diff(start));
    const parts: string[] = [];

    const days = duration.days();
    const hours = duration.hours();
    const minutes = duration.minutes();
    const seconds = duration.seconds();
    const milliseconds = duration.milliseconds();

    if (days > 0) {
      parts.push(`${days} day${days > 1 ? 's' : ''}`);
    }
    if (hours > 0) {
      parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
    }
    if (minutes > 0) {
      parts.push(`${minutes} min${minutes > 1 ? 's' : ''}`);
    }
    if (seconds > 0) {
      parts.push(`${seconds} sec${seconds > 1 ? 's' : ''}`);
    }
    if (days == 0 && hours == 0 && minutes == 0 && seconds == 0) {
      parts.push(`${milliseconds} ms`);
    }

    return parts.join(' ');
  }

  /** The ledger in SERIES order: oldest-first by the row's `created`, id tiebreak. */
  private ledgerInSeriesOrder(migrationTable: Table<Migration>) {
    return new QueryBuilderFactory().createQueryBuilder(migrationTable).sort([
      { field: 'created', desc: false },
      { field: 'id', desc: false },
    ]);
  }

  /**
   * One owner of "what does a ledger row mean for the series": retired rows are skipped; rows
   * with no source record are unresolved (the RUN stamps them retired; the plan reports them);
   * `manual` declarations are excluded; 'success' rows are already applied; anything else is
   * pending — including 'running' (a crashed earlier run). Pure over the rows: no writes.
   */
  private classifyLedger(ledger: Migration[], sourceOf: (id: string) => Migration | undefined): LedgerClassification {
    const classified: LedgerClassification = {
      pending: [],
      skippedManual: [],
      alreadyApplied: [],
      unresolved: [],
      retired: [],
    };
    for (const row of ledger) {
      if (row.retired) {
        classified.retired.push(row.id);
        continue;
      }
      const source = sourceOf(row.id);
      if (!source) {
        classified.unresolved.push(row.id);
        continue;
      }
      if (source.manual) {
        classified.skippedManual.push(row.id);
        continue;
      }
      if (row.status === 'success') {
        classified.alreadyApplied.push(row.id);
        continue;
      }
      classified.pending.push(source);
    }
    return classified;
  }

  /** This build's migration declarations by id — the reflection source-record loaders for the migration table. */
  private declaredMigrations(migrationTable: Table<Migration>): Map<string, Migration> {
    const declared = new Map<string, Migration>();
    for (const { loader } of getSourceRecordLoaders<Migration>()) {
      if (loader.table.name === migrationTable.name) {
        const migration = loader.record as Migration;
        declared.set(migration.id, migration);
      }
    }
    return declared;
  }

  /**
   * The plan's lines: each pending migration's estimate (read here — the one call of
   * {@link Migration.estimate}), logged as one line, then the total. Read-only by the door's
   * contract; nothing here writes.
   */
  private async estimateSeries(
    pending: Migration[],
    context: Omit<MigrationPlan, 'pending' | 'projectedSeconds' | 'projected' | 'unprojected'>
  ): Promise<MigrationPlan> {
    const plan: MigrationPlan = {
      pending: [],
      projectedSeconds: 0,
      projected: 0,
      unprojected: [],
      skippedManual: context.skippedManual,
      alreadyApplied: context.alreadyApplied,
      unresolved: context.unresolved,
      retired: context.retired,
      freshDatabase: context.freshDatabase,
    };
    for (const migration of pending) {
      const entry: MigrationPlanEntry = {
        id: migration.id,
        description: migration.description,
        ...(migration.preSchemaSync ? { preSchemaSync: true } : {}),
      };
      if (context.freshDatabase) {
        entry.unprojectedReason = 'fresh database, nothing to count';
      } else if (!migration.estimate) {
        entry.unprojectedReason = 'no estimate declared';
      } else {
        entry.estimate = await migration.estimate();
        if (entry.estimate.secondsPerUnit === undefined) {
          entry.unprojectedReason = 'no seconds per unit declared';
        } else {
          entry.projectedSeconds = Math.ceil(entry.estimate.units * entry.estimate.secondsPerUnit);
        }
      }
      if (entry.projectedSeconds === undefined) {
        plan.unprojected.push(entry.id);
      } else {
        plan.projected++;
        plan.projectedSeconds += entry.projectedSeconds;
      }
      plan.pending.push(entry);
      this.logger.info({ message: this.planLine(entry) });
    }
    const without =
      plan.unprojected.length > 0
        ? `, ${plan.unprojected.length} without a projection (${plan.unprojected.join(', ')})`
        : '';
    this.logger.info({
      message:
        `Migration plan total: ${plan.pending.length} pending, ≈ ${plan.projectedSeconds} s projected over ` +
        `${plan.projected} of them${without}`,
      obj: plan as any,
    });
    return plan;
  }

  /** One line per pending migration: the count, the unit, the projection when there is one, the note. */
  private planLine(entry: MigrationPlanEntry): string {
    const head = `Migration plan: (${entry.id}) ${entry.description}${entry.preSchemaSync ? ' [runs at init, before schema sync]' : ''} — `;
    if (!entry.estimate) {
      return `${head}${entry.unprojectedReason}`;
    }
    const { units, unit, secondsPerUnit, note } = entry.estimate;
    const projection =
      entry.projectedSeconds === undefined
        ? entry.unprojectedReason
        : `≈ ${entry.projectedSeconds} s at ${secondsPerUnit} s per unit`;
    return `${head}${units} ${unit}, ${projection}${note ? ` (${note})` : ''}`;
  }
}
