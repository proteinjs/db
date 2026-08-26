import { Moment, moment } from './opt/moment';
import { Db, getDb, getDbAsSystem } from './Db';
import { Table } from './Table';
import { SourceRecordRepo } from './source/SourceRecordRepo';
import { SourceRecordLoader } from './source/SourceRecordLoader';
import { getSourceRecordLoaders } from './source/SourceRecord';
import { MigrationRunnerService, getMigrationRunnerService } from './services/MigrationRunnerService';
import { Migration, MigrationTable } from './tables/MigrationTable';
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
    await new SourceRecordLoader().load(migrationTable);
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
    const qb = new QueryBuilderFactory().createQueryBuilder(migrationTable).sort([
      { field: 'created', desc: false },
      { field: 'id', desc: false },
    ]);
    const ledger = await db.query(migrationTable, qb);

    const summary: MigrationSeriesSummary = {
      applied: [],
      skippedManual: [],
      alreadyApplied: [],
      unresolved: [],
      retired: [],
      notAttempted: [],
    };
    const sourceRecordRepo = new SourceRecordRepo();
    const pending: Migration[] = [];
    for (const row of ledger) {
      if (row.retired) {
        summary.retired.push(row.id);
        continue;
      }
      const source = sourceRecordRepo.getSourceRecord<Migration>(migrationTable.name, row.id);
      if (!source) {
        // Stamp, don't just skip: the ledger must remember the source class was gone. If the
        // class ships again in a later build, the row stays excluded until a human un-retires it
        // on the Migrations page — a returned loader id is not consent to auto-run.
        await db.update(migrationTable, { id: row.id, retired: true } as Partial<Migration>);
        summary.unresolved.push(row.id);
        continue;
      }
      if (source.manual) {
        summary.skippedManual.push(row.id);
        continue;
      }
      if (row.status === 'success') {
        summary.alreadyApplied.push(row.id);
        continue;
      }
      pending.push(row);
    }

    this.logger.info({
      message: `Running ${pending.length} pending migration${pending.length === 1 ? '' : 's'} in series, oldest-first`,
      obj: {
        pending: pending.map((row) => row.id),
        skippedManual: summary.skippedManual,
        skippedRetired: summary.retired,
        stampedRetired: summary.unresolved,
      },
    });
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
      summary.notAttempted = pending.slice(i + 1).map((row) => row.id);
      break;
    }

    this.logger.info({ message: `Migration series finished`, obj: summary as any });
    return summary;
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
}
