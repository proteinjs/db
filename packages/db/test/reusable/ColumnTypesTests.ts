import { Db, DbDriver, Record, Table, DefaultTransactionContextFactory } from '@proteinjs/db';
import { DbTestEnvironment } from '../util/DbTestEnvironment';
import { columnTypesTestTables, TestRecord } from '../util/tables/columnTypesTestTables';

export const columnTypeTests = (
  driver: DbDriver,
  transactionContextFactory: DefaultTransactionContextFactory,
  dropTable: (table: Table<any>) => Promise<void>
) => {
  return () => {
    const db = new Db(driver, undefined, transactionContextFactory);
    const testEnv = new DbTestEnvironment(driver, dropTable);

    beforeAll(async () => await testEnv.beforeAll(), 10000);
    afterAll(async () => await testEnv.afterAll(), 10000);

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

      const testTable: Table<TestRecord> = columnTypesTestTables.Test;
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
      expect(fetchedRecord.referenceColumn).toBeNull();
      expect(fetchedRecord.referenceArrayColumn).toHaveProperty('_ids', []);

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

      const testTable: Table<TestRecord> = columnTypesTestTables.Test;

      await expect(db.insert(testTable, testRecord)).rejects.toThrow();
    });
  };
};
