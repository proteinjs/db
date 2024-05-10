import { SourceRecord } from './SourceRecord';

export class SourceRecordRepo {
  private static SOURCE_RECORD_MAP: { [key: string]: SourceRecord } = {};

  private getKey(tableName: string, recordId: string) {
    return `${tableName}:${recordId}`;
  }

  loadSourceRecord(tableName: string, sourceRecord: SourceRecord): void {
    SourceRecordRepo.SOURCE_RECORD_MAP[this.getKey(tableName, sourceRecord.id)] = sourceRecord;
  }

  getSourceRecord<T extends SourceRecord = SourceRecord>(tableName: string, sourceRecordId: string): T | undefined {
    return SourceRecordRepo.SOURCE_RECORD_MAP[this.getKey(tableName, sourceRecordId)] as T;
  }
}
