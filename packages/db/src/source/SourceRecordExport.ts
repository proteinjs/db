import { Service } from '@proteinjs/service';
import { Logger } from '@proteinjs/logger';
import { getDbAsSystem } from '../Db';
import { Table, tableByName } from '../Table';
import { SourceRecord, isSourceRecordTable } from './SourceRecord';
import { SourceRecordDeclarationBundle, SourceRecordDeclarationDocument } from './SourceRecordDeclaration';
import { getSourceRecordExportConfig } from './SourceRecordExportConfig';
import { SOURCE_RECORD_EXPORT_PERMISSION, SourceRecordExportService } from '../services/SourceRecordExportService';

/**
 * The export door's implementation (see {@link SourceRecordExportService}). Reads the table as
 * system — the door itself is what the grant guards — and renders only what the table declares
 * exportable: a column outside `sourceRecordOptions.declarationColumns` never leaves, whatever a
 * row holds in it, and a row outside `sourceRecordOptions.declarationFilter` is never read.
 * Refuses a table that is not a source-record table or declares no declaration columns, and an
 * environment that cannot name itself.
 */
export class SourceRecordExport implements SourceRecordExportService {
  private logger = new Logger({ name: this.constructor.name });
  public serviceMetadata: Service['serviceMetadata'] = {
    auth: {
      permission: SOURCE_RECORD_EXPORT_PERMISSION,
    },
  };

  async export(tableName: string): Promise<SourceRecordDeclarationBundle> {
    const table = tableByName(tableName) as Table<SourceRecord>;
    if (!isSourceRecordTable(table)) {
      throw new Error(`(${tableName}) Not a source-record table — nothing to export`);
    }
    if (SourceRecordDeclarationDocument.declarationColumns(table).size === 0) {
      throw new Error(
        `(${tableName}) The table declares no declaration columns (sourceRecordOptions.declarationColumns) — not exportable`
      );
    }
    const { environment } = getSourceRecordExportConfig();
    const { filter } = SourceRecordDeclarationDocument.shapeOf(table);
    const rows = (await getDbAsSystem().query(table, filter)) as SourceRecord[];
    const bundle = await SourceRecordDeclarationDocument.fromRecords(table, rows, {
      environment,
      exportedAt: new Date().toISOString(),
    });
    const { rowCount } = bundle.declaration;
    this.logger.info({
      message: `(${tableName}) Exported ${rowCount} ${rowCount == 1 ? 'row' : 'rows'} as a declaration`,
    });
    return bundle;
  }
}
