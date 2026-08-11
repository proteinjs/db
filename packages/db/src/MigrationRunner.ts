import { Moment, moment } from './opt/moment';
import { getDb } from './Db';
import { Table } from './Table';
import { SourceRecordRepo } from './source/SourceRecordRepo';
import { MigrationRunnerService, getMigrationRunnerService } from './services/MigrationRunnerService';
import { Migration, MigrationTable } from './tables/MigrationTable';
import { Service } from '@proteinjs/service';
import { Logger } from '@proteinjs/logger';

export const getMigrationRunner = () =>
  typeof self === 'undefined' ? new MigrationRunner() : (getMigrationRunnerService() as MigrationRunner);

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
    const migration = new SourceRecordRepo().getSourceRecord<Migration>(migrationTable.name, id);
    if (!migration) {
      throw new Error(`Unable to find migration source record for id: ${id}`);
    }

    return this.runAndRecord(migrationTable, migration);
  }

  private async runAndRecord(migrationTable: Table<Migration>, migration: Migration): Promise<void> {
    const db = getDb();
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
