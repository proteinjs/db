import { Moment } from '../opt/moment';
import { BooleanColumn, DateTimeColumn, ObjectColumn, StringColumn } from '../Columns';
import { Table } from '../Table';
import { SourceRecord, withSourceRecordColumns } from '../source/SourceRecord';

export interface Migration extends SourceRecord {
  description: string;
  /**
   * The explicit non-automatable class (plans/POST_RELEASE_QUEUE.md 27f): destructive
   * contractions (column/table drops), long backfills over big tables, data-dependent one-offs.
   * `manual: true` EXCLUDES the migration from the deploy-gated auto-run
   * ({@link MigrationRunner.runPendingMigrations}); it keeps the Migrations-page flow
   * (`runMigration`). Absence of the flag = automated — the invariant lives here, in the
   * schema, not in deploy-pipeline prose.
   */
  manual?: boolean;
  /**
   * Runs during `Db.init()` BEFORE schema sync (the pre-schema-sync phase —
   * {@link MigrationRunner.runPreSchemaSyncMigrations}), instead of after init like the
   * deploy-gated series. This is the class for data repairs a NEW SCHEMA INVARIANT depends on —
   * e.g. deduplicating rows before a unique index lands: schema sync's unique-index preflight
   * fails loudly over violating data ({@link DuplicateValuesForUniqueIndexError}), and the
   * ordinary series (deploy Job, after init) is too late by construction.
   *
   * Contract for this class (stricter than the ordinary automated class):
   * - IDEMPOTENT and tolerant of CONCURRENT duplicate runs: every booting replica and the deploy
   *   Job each run init — two actors can observe the row un-applied and both run the body.
   * - TABLE-EXISTENCE tolerant: on a fresh database the body runs before ANY schema sync, so its
   *   target tables may not exist yet (check and no-op — a fresh database has nothing to repair).
   * - Never `manual` (a contradiction — the phase exists to run unattended before DDL; declaring
   *   both fails init loudly).
   * A failure fails `Db.init()` loudly (recorded on the ledger row, retried next boot) — exactly
   * the failure the schema sync would otherwise hit, but named and retryable.
   *
   * The phase reads the SOURCE declaration (like {@link runPendingMigrations} reads
   * `source.manual`); the column mirrors it into the ledger so the Migrations page shows why a
   * row ran at boot.
   */
  preSchemaSync?: boolean;
  /**
   * Ledger-owned state (like `status` — never declared on a source record): stamped `true` by the
   * deploy-gated series ({@link MigrationRunner.runPendingMigrations}) when the row's source class
   * no longer ships. A retired row is NEVER auto-run — even if its source class returns in a later
   * build — until someone un-retires it on the Migrations page (the record form's Un-retire
   * button). A returned loader id is not consent to auto-run.
   */
  retired?: boolean;
  status?: 'proposed' | 'running' | 'success' | 'failure';
  failureMessage?: string;
  failureStack?: string;
  startTime?: Moment;
  endTime?: Moment;
  duration?: string;
  output?: any;
  run: () => Promise<any | void>;
}

export class MigrationTable extends Table<Migration> {
  public name = 'migration';
  /**
   * The doors ride the 'dev' permission (consumer-mapped; admin passes as break-glass),
   * matching MigrationRunner's serviceMetadata: the Migrations record table reads/edits via
   * the service api, and the runner writes run state via the db api as the calling user.
   * INSERT deliberately has no door — for anyone, break-glass included: ledger rows are born
   * from source declarations only (boot-time loading rides getDbAsSystem, which bypasses
   * doors), so a caller-path insert could only mint a row no source owns. The generic record
   * surfaces derive their affordances from these doors (db-ui renders no create button here).
   */
  public auth: Table<Migration>['auth'] = {
    db: { query: { permission: 'dev' }, update: { permission: 'dev' }, delete: { permission: 'dev' } },
    service: { query: { permission: 'dev' }, update: { permission: 'dev' }, delete: { permission: 'dev' } },
  };
  /**
   * The row scan the founder actually reads: what ran, how it went, HOW LONG it took
   * (duration — stamped by the runner at completion; the default pick's five-column cap
   * dropped it), then the declaration flags. Failure detail and timestamps stay on the
   * record form.
   */
  public ui: Table<Migration>['ui'] = {
    recordTable: {
      columns: ['description', 'status', 'duration', 'manual', 'preSchemaSync', 'retired'],
    },
  };
  public columns = withSourceRecordColumns<Migration>({
    description: new StringColumn('description', { encrypted: false }, 4000), // dev-authored system prose
    manual: new BooleanColumn('manual'),
    preSchemaSync: new BooleanColumn('pre_schema_sync'),
    retired: new BooleanColumn('retired'),
    status: new StringColumn('status', { encrypted: false, defaultValue: async () => 'proposed' }),
    failureMessage: new StringColumn('failure_message', { encrypted: false }, 4000),
    failureStack: new StringColumn('failure_stack', { encrypted: false }, 'MAX'),
    startTime: new DateTimeColumn('start_time'),
    endTime: new DateTimeColumn('end_time'),
    duration: new StringColumn('duration', { encrypted: false }),
    output: new ObjectColumn('output', { encrypted: false }),
  });
  public sourceRecordOptions: Table<Migration>['sourceRecordOptions'] = {
    // The ledger outlives the migration class: run history stays when the source is deleted.
    onSourceRemoved: 'keep',
    ui: {
      hideColumns: true,
    },
  };
}
