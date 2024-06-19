import { Db, DbDriver } from '../src/Db';
import { Moment } from 'moment';
import { ReferenceArray } from '../src/reference/ReferenceArray';
import { Reference } from '../src/reference/Reference';
import {
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
} from '../src/Columns';
import { withRecordColumns, Record } from '../src/Record';
import { Table } from '../src/Table';

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
  public name = 'db_test_table';
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

/**
 * Used for testing purposes only.
 *  */
export const getColumnTypeTestTable = (tableName: string) => {
  const testTable = new TestTable();
  if (testTable.name === tableName) {
    return new TestTable();
  }
  throw new Error(`Cannot find test table: ${tableName}`);
};

export const columnTypeTests = (driver: DbDriver, dropTable: (table: TestTable) => Promise<void>) => {
  return () => {
    const db = new Db(driver, getColumnTypeTestTable);

    beforeAll(async () => {
      if (driver.start) {
        await driver.start();
      }

      await driver.getTableManager().loadTable(new TestTable());
    });

    afterAll(async () => {
      await dropTable(new TestTable());

      if (driver.stop) {
        await driver.stop();
      }
    });

    test('Insert record with all null values', async () => {
      const testRecord: Omit<TestRecord, keyof Record> = {
        integerColumn: null,
        stringColumn: null,
        floatColumn: null,
        decimalColumn: null,
        booleanColumn: null,
        dateColumn: null,
        dateTimeColumn: null,
        binaryColumn: null,
        uuidColumn: null,
        passwordColumn: null,
        objectColumn: null,
        arrayColumn: null,
        referenceArrayColumn: null,
        referenceColumn: null,
      };

      const testTable: Table<TestRecord> = new TestTable();
      const insertedRecord = await db.insert(testTable, testRecord);
      const fetchedRecord = await db.get(testTable, { id: insertedRecord.id });

      expect(fetchedRecord).toBeTruthy();
      expect(fetchedRecord.integerColumn).toBeNull();
      expect(fetchedRecord.stringColumn).toBeNull();
      expect(fetchedRecord.floatColumn).toBeNull();
      expect(fetchedRecord.decimalColumn).toBeNull();
      expect(fetchedRecord.booleanColumn).toBeNull();
      expect(fetchedRecord.dateColumn).toBeNull();
      expect(fetchedRecord.dateTimeColumn).toBeNull();
      expect(fetchedRecord.binaryColumn).toBeNull();
      expect(fetchedRecord.uuidColumn).toBeNull();
      expect(fetchedRecord.passwordColumn).toBeNull();
      expect(fetchedRecord.objectColumn).toBeNull();
      expect(fetchedRecord.arrayColumn).toBeNull();
      expect(fetchedRecord.referenceArrayColumn).toBeNull();
      expect(fetchedRecord.referenceColumn).toBeNull();

      // Clean up
      await db.delete(testTable, { id: fetchedRecord.id });
    });

    test('Insert record with all undefined values', async () => {
      const testRecord: Omit<TestRecord, keyof Record> = {
        integerColumn: undefined,
        stringColumn: undefined,
        floatColumn: undefined,
        decimalColumn: undefined,
        booleanColumn: undefined,
        dateColumn: undefined,
        dateTimeColumn: undefined,
        binaryColumn: undefined,
        uuidColumn: undefined,
        passwordColumn: undefined,
        objectColumn: undefined,
        arrayColumn: undefined,
        referenceArrayColumn: undefined,
        referenceColumn: undefined,
      };

      const testTable: Table<TestRecord> = new TestTable();

      await expect(db.insert(testTable, testRecord)).rejects.toThrow();
    });
  };
};
