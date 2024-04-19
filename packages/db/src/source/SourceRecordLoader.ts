import { Logger } from '@proteinjs/util';
import { QueryBuilder } from '@proteinjs/db-query';
import { getSourceRecordLoaders, SourceRecord, getSourceRecordTables } from './SourceRecord';
import { Table } from '../Table';
import { getSystemDb } from '../Db';
import { SourceRecordRepo } from './SourceRecordRepo';

type SourceRecordsMap = {[tableName: string]: { table: Table<any>, records: Omit<SourceRecord, 'created'|'updated'>[], recordIds: string[] }}

export class SourceRecordLoader {
  private logger = new Logger(this.constructor.name);

  async load() {
    const sourceRecordsMap = await this.getSourceRecordsMap();
    const db = getSystemDb();
    for (let tableName in sourceRecordsMap) {
      let insertCount = 0;
      let updateCount = 0;
      let deleteCount = 0;
      const table = sourceRecordsMap[tableName].table;
      const sourceRecordIds = sourceRecordsMap[tableName].recordIds;
      if (!table.sourceRecordOptions.doNotDeleteSourceRecordsFromDb) {
        const qb = QueryBuilder.fromObject<SourceRecord>({ isLoadedFromSource: true }, table.name);
        if (sourceRecordIds.length > 0)
          qb.condition({ field: 'id', operator: 'NOT IN', value: sourceRecordIds });
        
        deleteCount = await db.delete(table, qb);
      }
  
      const sourceRecords = sourceRecordsMap[tableName].records;
      for (let sourceRecord of sourceRecords) {
        sourceRecord.isLoadedFromSource = true;
        const count = await db.update(table, sourceRecord);
        if (count > 0) {
          updateCount += count;
        } else {
          const dbSourceRecord = await db.insert(table, sourceRecord);
          sourceRecord = { ...sourceRecord, ...dbSourceRecord };
          insertCount += 1;
        }
  
        new SourceRecordRepo().loadSourceRecord(table.name, sourceRecord as any)
      }
      
      this.logger.info(`(${table.name}) Loaded ${sourceRecords.length} ${sourceRecords.length == 1 ? 'record' : 'records'} from source (inserts: ${insertCount}, updates: ${updateCount}, deletes: ${deleteCount})`);
    }
  }

  private async getSourceRecordsMap() {
    const sourceRecordsMap: SourceRecordsMap = {};
    const sourceRecordTables = getSourceRecordTables();
    for (let sourceRecordTable of sourceRecordTables) {
      if (!sourceRecordsMap[sourceRecordTable.name])
        sourceRecordsMap[sourceRecordTable.name] = { table: sourceRecordTable, records: [], recordIds: []};
    }

    const sourceRecordLoaders = getSourceRecordLoaders();
    for (let sourceRecordLoader of sourceRecordLoaders) {
      if (!sourceRecordsMap[sourceRecordLoader.table.name])
        sourceRecordsMap[sourceRecordLoader.table.name] = { table: sourceRecordLoader.table, records: [], recordIds: []};
  
      sourceRecordsMap[sourceRecordLoader.table.name].records.push(sourceRecordLoader.record);
      sourceRecordsMap[sourceRecordLoader.table.name].recordIds.push(sourceRecordLoader.record.id);
    }
  
    return sourceRecordsMap;
  }
}