import { Moment } from 'moment';
import {
  ReferenceArray,
  Reference,
  withRecordColumns,
  Record,
  Table,
  IntegerColumn,
  StringColumn,
  FloatColumn,
  DecimalColumn,
  BooleanColumn,
  DateColumn,
  DateTimeColumn,
  BinaryColumn,
  UuidColumn,
  PasswordColumn,
  ObjectColumn,
  ArrayColumn,
  ReferenceArrayColumn,
  ReferenceColumn,
} from '@proteinjs/db';

export interface TestRecord extends Record {
  integerColumn?: number | null;
  stringColumn?: string | null;
  floatColumn?: number | null;
  decimalColumn?: number | null;
  booleanColumn?: boolean | null;
  dateColumn?: Date | null;
  dateTimeColumn?: Moment | null;
  binaryColumn?: number | null;
  uuidColumn?: string | null;
  passwordColumn?: string | null;
  objectColumn?: any | null;
  arrayColumn?: any[] | null;
  referenceArrayColumn?: ReferenceArray<any> | null;
  referenceColumn?: Reference<any> | null;
}

export class TestTable extends Table<TestRecord> {
  public name = 'db_test_ct_table';
  public columns = withRecordColumns<TestRecord>({
    integerColumn: new IntegerColumn('integer_column'),
    stringColumn: new StringColumn('string_column', {}, 255),
    floatColumn: new FloatColumn('float_column'),
    decimalColumn: new DecimalColumn('decimal_column'),
    booleanColumn: new BooleanColumn('boolean_column'),
    dateColumn: new DateColumn('date_column'),
    dateTimeColumn: new DateTimeColumn('date_time_column'),
    binaryColumn: new BinaryColumn('binary_column'),
    uuidColumn: new UuidColumn('uuid_column'),
    passwordColumn: new PasswordColumn('password_column'),
    objectColumn: new ObjectColumn('object_column'),
    arrayColumn: new ArrayColumn('array_column'),
    referenceArrayColumn: new ReferenceArrayColumn('reference_array_column', 'reference_table', false),
    referenceColumn: new ReferenceColumn('reference_column', 'reference_table', false),
  });
}

export const columnTypesTestTables = {
  Test: new TestTable() as Table<TestRecord>,
};
