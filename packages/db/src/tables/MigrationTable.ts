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
   * Both doors ride the 'dev' permission (consumer-mapped; admin passes as break-glass),
   * matching MigrationRunner's serviceMetadata: the Migrations record table reads/edits via
   * the service api, and the runner writes run state via the db api as the calling user.
   * Boot-time source-record loading is a system path (getDbAsSystem) and bypasses doors.
   */
  public auth: Table<Migration>['auth'] = {
    db: { all: { permission: 'dev' } },
    service: { all: { permission: 'dev' } },
  };
  public columns = withSourceRecordColumns<Migration>({
    description: new StringColumn('description', {}, 4000),
    manual: new BooleanColumn('manual'),
    retired: new BooleanColumn('retired'),
    status: new StringColumn('status', { defaultValue: async () => 'proposed' }),
    failureMessage: new StringColumn('failure_message', {}, 4000),
    failureStack: new StringColumn('failure_stack', {}, 'MAX'),
    startTime: new DateTimeColumn('start_time'),
    endTime: new DateTimeColumn('end_time'),
    duration: new StringColumn('duration'),
    output: new ObjectColumn('output'),
  });
  public sourceRecordOptions = {
    doNotDeleteSourceRecordsFromDb: true,
    ui: {
      hideColumns: true,
    },
  };
}
