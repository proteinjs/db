import { Moment, moment } from './opt/moment';
import { Db, getDb, getDbAsSystem } from './Db';
import { Table } from './Table';
import { SourceRecordRepo } from './source/SourceRecordRepo';
import { MigrationRunnerService, getMigrationRunnerService } from './services/MigrationRunnerService';
import { Migration, MigrationTable } from './tables/MigrationTable';
import { QueryBuilderFactory } from './QueryBuilderFactory';
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
  /** Ledger rows with no source record (a loader deleted after its run; the table keeps history). */
  unresolved: string[];
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
   * - rows with no source record are history (a loader deleted after its run) — skipped,
   *   reported as `unresolved`.
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
      notAttempted: [],
    };
    const sourceRecordRepo = new SourceRecordRepo();
    const pending: Migration[] = [];
    for (const row of ledger) {
      const source = sourceRecordRepo.getSourceRecord<Migration>(migrationTable.name, row.id);
      if (!source) {
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
      obj: { pending: pending.map((row) => row.id), skippedManual: summary.skippedManual },
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
    await db.update(migrationTable, migration);
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
    await db.update(migrationTable, migration);
    this.logger.info({
      message: `[${migration.status}] (${migration.duration}) Finished running migration (${migration.id}) ${migration.description}`,
    });
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
