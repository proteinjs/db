import { Service, serviceFactory } from '@proteinjs/service';
import { SourceRecordDeclaration } from '../source/SourceRecordDeclaration';

/**
 * The permission slug behind the export door. The library declares it; the consumer app maps
 * it to roles through its `PermissionRolesMapping` (admin passes as break-glass). Unmapped, no
 * one but an admin can export — default-deny.
 */
export const SOURCE_RECORD_EXPORT_PERMISSION = 'source-records-export';

export const getSourceRecordExportService = serviceFactory<SourceRecordExportService>(
  '@proteinjs/db/SourceRecordExportService'
);

/**
 * THE EXPORT DOOR: a source-record table's rows rendered back into a declaration (see
 * {@link SourceRecordDeclaration}) — the table's key, the columns the table declares
 * exportable and nothing else, every row (product-authored rows included: loaded elsewhere they
 * are the declaration's from then on), a header naming this environment. `source-records pull`
 * calls it with the consumer's own session and writes the file.
 */
export interface SourceRecordExportService extends Service {
  export(tableName: string): Promise<SourceRecordDeclaration>;
}
