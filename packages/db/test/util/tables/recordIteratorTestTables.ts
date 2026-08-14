import { Moment } from 'moment';
import { withRecordColumns, Record, IntegerColumn, StringColumn, DateTimeColumn, Table } from '@proteinjs/db';

export interface IterationRow extends Record {
  name: string;
  /** Deterministic integer sort axis (unique per row unless a test seeds ties). */
  seq?: number | null;
  /** Datetime sort axis for tie/round-trip coverage (values controlled by the tests). */
  stampedAt?: Moment | null;
}

export class RecordIteratorTestTable extends Table<IterationRow> {
  name = 'db_test_record_iterator';
  columns = withRecordColumns<IterationRow>({
    name: new StringColumn('name'),
    seq: new IntegerColumn('seq'),
    stampedAt: new DateTimeColumn('stamped_at'),
  });
}

export const recordIteratorTestTables = {
  IterationRow: new RecordIteratorTestTable() as Table<IterationRow>,
};
