import { Record, Reference, ReferenceColumn, Table, withRecordColumns } from '@proteinjs/db';

/**
 * The registered face of the width-adoption suite's table (ReferenceColumnAdoptWidth.test.ts):
 * the retyped declaration — a reference adopting the column's pre-existing STRING(255) width.
 * Declared here (not inline in the suite) because Db statement generation resolves tables by
 * NAME through the reflection registry; the suite's string-era and stock-width variants of the
 * same physical table stay inline there, reaching only instance-passed TableManager APIs.
 */

export interface AdoptWidthRecord extends Record {
  invitedBy?: Reference<Record> | null;
}

export const ADOPT_WIDTH_TABLE_NAME = 'db_test_reference_adopt_width';
export const ADOPT_WIDTH_TARGET_TABLE_NAME = 'db_test_reference_adopt_target';

export class ReferenceAdoptWidthTestTable extends Table<AdoptWidthRecord> {
  name = ADOPT_WIDTH_TABLE_NAME;
  columns = withRecordColumns<AdoptWidthRecord>({
    invitedBy: new ReferenceColumn<Record>('invited_by', ADOPT_WIDTH_TARGET_TABLE_NAME, false, { maxLength: 255 }),
  });
}
