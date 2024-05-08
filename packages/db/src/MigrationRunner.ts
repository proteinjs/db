import { Moment, moment } from './opt/moment';
import { getDb } from './Db';
import { Table } from './Table';
import { SourceRecordRepo } from './source/SourceRecordRepo';
import { MigrationRunnerService, getMigrationRunnerService } from './services/MigrationRunnerService';
import { Migration, MigrationTable } from './tables/MigrationTable';
import { Service } from '@proteinjs/service';
import { Logger } from '@proteinjs/util';

export const getMigrationRunner = () =>
  typeof self === 'undefined' ? new MigrationRunner() : (getMigrationRunnerService() as MigrationRunner);

export class MigrationRunner implements MigrationRunnerService {
  private logger = new Logger(this.constructor.name);
  public serviceMetadata: Service['serviceMetadata'] = {
    doNotAwait: true,
  };

  async runMigration(id: string): Promise<void> {
    const migrationTable: Table<Migration> = new MigrationTable();
    const migration = new SourceRecordRepo().getSourceRecord<Migration>(migrationTable.name, id);
    if (!migration) throw new Error(`Unable to find migration source record for id: ${id}`);

    const db = getDb();
    migration.status = 'running';
    migration.startTime = moment();
    await db.update(migrationTable, migration);
    this.logger.info(`Running migration (${migration.id}) ${migration.description}`);
    try {
      migration.output = await migration.run();
      migration.status = 'success';
    } catch (error: any) {
      migration.failureMessage = error.message;
      migration.failureStack = error.stack;
      migration.status = 'failure';
    } finally {
      migration.endTime = moment();
    }
    migration.duration = this.duration(migration.startTime, migration.endTime);
    await db.update(migrationTable, migration);
    this.logger.info(
      `[${migration.status}] (${migration.duration}) Finished running migration (${migration.id}) ${migration.description}`
    );
  }

  private duration(start: Moment, end: Moment): string {
    const duration = moment.duration(end.diff(start));
    const parts: string[] = [];

    const days = duration.days();
    const hours = duration.hours();
    const minutes = duration.minutes();
    const seconds = duration.seconds();
    const milliseconds = duration.milliseconds();

    if (days > 0) parts.push(`${days} day${days > 1 ? 's' : ''}`);
    if (hours > 0) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
    if (minutes > 0) parts.push(`${minutes} min${minutes > 1 ? 's' : ''}`);
    if (seconds > 0) parts.push(`${seconds} sec${seconds > 1 ? 's' : ''}`);
    if (days == 0 && hours == 0 && minutes == 0 && seconds == 0) parts.push(`${milliseconds} ms`);

    return parts.join(' ');
  }
}
