import { Service } from '@proteinjs/service';
import { Logger } from '@proteinjs/logger';
import { getDbAsSystem } from '../Db';
import { Table, tableByName } from '../Table';
import { SourceRecord, isSourceRecordTable } from './SourceRecord';
import { SourceRecordDeclaration, SourceRecordDeclarationDocument } from './SourceRecordDeclaration';
import { getSourceRecordExportConfig } from './SourceRecordExportConfig';
import { SOURCE_RECORD_EXPORT_PERMISSION, SourceRecordExportService } from '../services/SourceRecordExportService';

/**
 * The export door's implementation (see {@link SourceRecordExportService}). Reads the table as
 * system — the door itself is what the grant guards — and renders only what the table declares
 * exportable: a column outside `sourceRecordOptions.declarationColumns` never leaves, whatever a
 * row holds in it. Refuses a table that is not a source-record table or declares no
 * declaration columns, and an environment that cannot name itself.
 */
export class SourceRecordExport implements SourceRecordExportService {
  private logger = new Logger({ name: this.constructor.name });
  public serviceMetadata: Service['serviceMetadata'] = {
    auth: {
      permission: SOURCE_RECORD_EXPORT_PERMISSION,
    },
  };

  async export(tableName: string): Promise<SourceRecordDeclaration> {
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
    const rows = (await getDbAsSystem().query(table, {})) as SourceRecord[];
    const declaration = await SourceRecordDeclarationDocument.fromRecords(table, rows, {
      environment,
      exportedAt: new Date().toISOString(),
    });
    this.logger.info({
      message: `(${tableName}) Exported ${declaration.rowCount} ${declaration.rowCount == 1 ? 'row' : 'rows'} as a declaration`,
    });
    return declaration;
  }
}
