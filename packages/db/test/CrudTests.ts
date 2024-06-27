import { QueryBuilder } from '@proteinjs/db-query';
import { DbDriver, Db } from '../src/Db';
import { withRecordColumns, Record } from '../src/Record';
import { BooleanColumn, DateColumn, StringColumn } from '../src/Columns';
import { Table } from '../src/Table';

export interface Employee extends Record {
  name: string;
  department?: string;
  jobTitle?: string | null;
  isRemote?: boolean;
  startDate?: Date;
  object?: string;
}

export class EmployeeTestTable extends Table<Employee> {
  name = 'db_test_employee';
  columns = withRecordColumns<Employee>({
    name: new StringColumn('name'),
    department: new StringColumn('department'),
    isRemote: new BooleanColumn('is_remote'),
    jobTitle: new StringColumn('job_title'),
    startDate: new DateColumn('start_date'),
    object: new StringColumn('object'),
  });
}

export interface ReservedWordTest extends Record {
  name: string;
  order?: string;
  select?: string;
  join?: string;
}

export class ReservedWordTestTable extends Table<ReservedWordTest> {
  name = 'db_test_reserved_word';
  columns = withRecordColumns<ReservedWordTest>({
    name: new StringColumn('name'),
    order: new StringColumn('order'),
    select: new StringColumn('select'),
    join: new StringColumn('join'),
  });
}

/**
 * Used for testing purposes only.
 *  */
export const getTestTable = (tableName: string) => {
  const employeeTable = new EmployeeTestTable();
  if (employeeTable.name == tableName) {
    return new EmployeeTestTable();
  }

  const reservedWordTestTable = new ReservedWordTestTable();
  if (reservedWordTestTable.name == tableName) {
    return new ReservedWordTestTable();
  }

  throw new Error(`Cannot find test table: ${tableName}`);
};

export const crudTests = (driver: DbDriver, dropTable: (table: Table<any>) => Promise<void>) => {
  return () => {
    const db = new Db(driver, getTestTable);

    beforeAll(async () => {
      if (driver.start) {
        await driver.start();
      }

      await driver.getTableManager().loadTable(new EmployeeTestTable());
      await driver.getTableManager().loadTable(new ReservedWordTestTable());
    });

    afterAll(async () => {
      await dropTable(new EmployeeTestTable());
      await dropTable(new ReservedWordTestTable());

      if (driver.stop) {
        await driver.stop();
      }
    });

    test('Insert', async () => {
      const testEmployee: Omit<Employee, keyof Record> = { name: 'Veronica' };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();
      const insertedEmployee = await db.insert(emplyeeTable, testEmployee);
      const fetchedEmployee = await db.get(emplyeeTable, { id: insertedEmployee.id });
      expect(fetchedEmployee).toBeTruthy();
      await db.delete(emplyeeTable, { id: fetchedEmployee.id });
    });

    test('Update', async () => {
      const testEmployee: Omit<Employee, keyof Record> = { name: 'Veronica' };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();
      const insertedEmployee = await db.insert(emplyeeTable, testEmployee);
      const updateCount = await db.update(
        emplyeeTable,
        {
          name: 'Veronican',
          department: 'Cake Factory',
          object:
            '{"cookie":{"originalMaxAge":5184000000,"expires":"2024-07-08T06:16:07.134Z","httpOnly":true,"path":"/"},"passport":{"user":"brent@n3xa.io"}}',
        },
        { id: insertedEmployee.id }
      );
      expect(updateCount).toBe(1);
      const fetchedEmployee = await db.get(emplyeeTable, { id: insertedEmployee.id });
      expect(fetchedEmployee.name).toBe('Veronican');
      expect(fetchedEmployee.department).toBe('Cake Factory');
      await db.delete(emplyeeTable, { id: fetchedEmployee.id });
    });

    test('Delete', async () => {
      const testEmployee: Omit<Employee, keyof Record> = { name: 'Veronica' };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();
      const insertedEmployee = await db.insert(emplyeeTable, testEmployee);
      let fetchedEmployee = await db.get(emplyeeTable, { id: insertedEmployee.id });
      expect(fetchedEmployee).toBeTruthy();
      const deleteCount = await db.delete(emplyeeTable, { id: fetchedEmployee.id });
      expect(deleteCount).toBe(1);
      fetchedEmployee = await db.get(emplyeeTable, { id: insertedEmployee.id });
      expect(fetchedEmployee).toBeFalsy();
    });

    test('Query', async () => {
      const testEmployee1: Omit<Employee, keyof Record> = { name: 'Veronica', department: 'Cake Factory' };
      const testEmployee2: Omit<Employee, keyof Record> = { name: 'Brent', department: 'Cake Factory' };
      const testEmployee3: Omit<Employee, keyof Record> = { name: 'Sean', department: 'Pug Playhouse' };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();
      const fetchedEmployee1 = await db.insert(emplyeeTable, testEmployee1);
      const fetchedEmployee2 = await db.insert(emplyeeTable, testEmployee2);
      const fetchedEmployee3 = await db.insert(emplyeeTable, testEmployee3);
      const fetchedEmployees = await db.query(emplyeeTable, { department: 'Cake Factory' });
      expect(fetchedEmployees.length).toBe(2);
      expect(fetchedEmployees[0].name).toBe('Veronica');
      expect(fetchedEmployees[1].name).toBe('Brent');
      const qb = new QueryBuilder<Employee>(emplyeeTable.name).condition({
        field: 'id',
        operator: 'IN',
        value: [fetchedEmployee1.id, fetchedEmployee2.id, fetchedEmployee3.id],
      });
      await db.delete(emplyeeTable, qb);
    });

    test('Get row count', async () => {
      const testEmployee1: Omit<Employee, keyof Record> = { name: 'Veronica', department: 'Cake Factory' };
      const testEmployee2: Omit<Employee, keyof Record> = { name: 'Brent', department: 'Cake Factory' };
      const testEmployee3: Omit<Employee, keyof Record> = { name: 'Sean', department: 'Pug Playhouse' };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();
      const fetchedEmployee1 = await db.insert(emplyeeTable, testEmployee1);
      const fetchedEmployee2 = await db.insert(emplyeeTable, testEmployee2);
      const fetchedEmployee3 = await db.insert(emplyeeTable, testEmployee3);
      const rowCount = await db.getRowCount(emplyeeTable, { department: 'Cake Factory' });
      expect(rowCount).toBe(2);
      const qb = new QueryBuilder<Employee>(emplyeeTable.name).condition({
        field: 'id',
        operator: 'IN',
        value: [fetchedEmployee1.id, fetchedEmployee2.id, fetchedEmployee3.id],
      });
      await db.delete(emplyeeTable, qb);
    });

    test('Insert with null values', async () => {
      const testEmployee: Omit<Employee, keyof Record> = {
        name: 'Veronica',
        department: 'Cake Factory',
        jobTitle: null,
        isRemote: false,
      };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();
      const insertedEmployee = await db.insert(emplyeeTable, testEmployee);
      const fetchedEmployee = await db.get(emplyeeTable, { id: insertedEmployee.id });

      expect(fetchedEmployee).toBeTruthy();
      expect(fetchedEmployee.jobTitle).toBeNull();

      await db.delete(emplyeeTable, { id: fetchedEmployee.id });
    });

    test('Update with null values', async () => {
      const testEmployee: Omit<Employee, keyof Record> = {
        name: 'Cassidy',
        jobTitle: 'Cowboy',
        isRemote: false,
      };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();
      const insertedEmployee = await db.insert(emplyeeTable, testEmployee);
      const fetchedEmployee = await db.get(emplyeeTable, { id: insertedEmployee.id });
      expect(fetchedEmployee).toBeTruthy();

      const nullUpdateCount = await db.update(emplyeeTable, { jobTitle: null }, { id: insertedEmployee.id });
      expect(nullUpdateCount).toBe(1);
      await db.delete(emplyeeTable, { id: fetchedEmployee.id });
    });

    test('Query with null values', async () => {
      const testEmployee: Omit<Employee, keyof Record> = {
        name: 'Cassidy',
        jobTitle: null,
        isRemote: false,
      };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();
      const insertedEmployee = await db.insert(emplyeeTable, testEmployee);

      const qb = new QueryBuilder<Employee>(emplyeeTable.name)
        .condition({
          field: 'jobTitle',
          operator: 'IS NULL',
        })
        .condition({ field: 'id', operator: '=', value: insertedEmployee.id });
      const rows = await db.query(emplyeeTable, qb);
      expect(rows.length).toEqual(1);
      await db.delete(emplyeeTable, { id: insertedEmployee.id });
    });

    test('Query with IN and NOT IN operators, including null values', async () => {
      const testEmployee1: Omit<Employee, keyof Record> = { name: 'Veronica', jobTitle: 'Engineer' };
      const testEmployee2: Omit<Employee, keyof Record> = { name: 'Zenyatta', jobTitle: null };
      const testEmployee3: Omit<Employee, keyof Record> = { name: 'Cassidy', jobTitle: 'Cowboy' };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();
      const insertedEmployee1 = await db.insert(emplyeeTable, testEmployee1);
      const insertedEmployee2 = await db.insert(emplyeeTable, testEmployee2);
      const insertedEmployee3 = await db.insert(emplyeeTable, testEmployee3);

      const inQuery = new QueryBuilder<Employee>(emplyeeTable.name).condition({
        field: 'jobTitle',
        operator: 'IN',
        value: ['Engineer', null],
      });
      const inResults = await db.query(emplyeeTable, inQuery);
      expect(inResults.length).toBe(1);
      expect(inResults.some((emp) => emp.jobTitle === 'Engineer')).toBe(true);

      const notInQuery = new QueryBuilder<Employee>(emplyeeTable.name).condition({
        field: 'jobTitle',
        operator: 'NOT IN',
        value: ['Engineer', null],
      });
      const notInResults = await db.query(emplyeeTable, notInQuery);
      expect(notInResults.length).toBe(0);

      // Clean up
      const qb = new QueryBuilder<Employee>(emplyeeTable.name).condition({
        field: 'id',
        operator: 'IN',
        value: [insertedEmployee1.id, insertedEmployee2.id, insertedEmployee3.id],
      });
      await db.delete(emplyeeTable, qb);
    });

    test('Query with BETWEEN operator', async () => {
      const testEmployee1: Omit<Employee, keyof Record> = {
        name: 'Veronica',
        jobTitle: 'Engineer',
        startDate: new Date('1997-10-24T00:00:00Z'),
      };
      const testEmployee2: Omit<Employee, keyof Record> = {
        name: 'Kiriko',
        jobTitle: null,
        startDate: new Date('2022-10-04T00:00:00Z'),
      };
      const testEmployee3: Omit<Employee, keyof Record> = {
        name: 'Cassidy',
        jobTitle: 'Cowboy',
        startDate: new Date('2016-05-24T00:00:00Z'),
      };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();

      const insertedEmployee1 = await db.insert(emplyeeTable, testEmployee1);
      const insertedEmployee2 = await db.insert(emplyeeTable, testEmployee2);
      const insertedEmployee3 = await db.insert(emplyeeTable, testEmployee3);

      const betweenQuery = new QueryBuilder<Employee>(emplyeeTable.name).condition({
        field: 'startDate',
        operator: 'BETWEEN',
        value: ['2000-06-05T00:00:00Z', '2024-06-05T00:00:00Z'],
      });
      const betweenResults = await db.query(emplyeeTable, betweenQuery);
      expect(betweenResults.length).toBe(2);
      expect(betweenResults.some((emp) => emp.name === 'Kiriko')).toBe(true);
      expect(betweenResults.some((emp) => emp.name === 'Cassidy')).toBe(true);

      // Clean up
      const qb = new QueryBuilder<Employee>(emplyeeTable.name).condition({
        field: 'id',
        operator: 'IN',
        value: [insertedEmployee1.id, insertedEmployee2.id, insertedEmployee3.id],
      });
      await db.delete(emplyeeTable, qb);
    });

    test('Query with sort', async () => {
      const testEmployee1: Omit<Employee, keyof Record> = {
        name: 'Veronica',
        jobTitle: 'Engineer',
      };
      const testEmployee2: Omit<Employee, keyof Record> = {
        name: 'Kiriko',
        jobTitle: null,
      };
      const testEmployee3: Omit<Employee, keyof Record> = {
        name: 'Cassidy',
        jobTitle: 'Cowboy',
      };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();

      const insertedEmployee1 = await db.insert(emplyeeTable, testEmployee1);
      const insertedEmployee2 = await db.insert(emplyeeTable, testEmployee2);
      const insertedEmployee3 = await db.insert(emplyeeTable, testEmployee3);

      const sortQuery = new QueryBuilder<Employee>(emplyeeTable.name).sort([
        { field: 'name', byValues: ['Cassidy', 'Veronica', 'Kiriko'] },
      ]);
      const sortResults = await db.query(emplyeeTable, sortQuery);

      // Assertions
      expect(sortResults.length).toBe(3);
      expect(sortResults[0].name).toBe('Cassidy');
      expect(sortResults[1].name).toBe('Veronica');
      expect(sortResults[2].name).toBe('Kiriko');

      // Clean up
      const qb = new QueryBuilder<Employee>(emplyeeTable.name).condition({
        field: 'id',
        operator: 'IN',
        value: [insertedEmployee1.id, insertedEmployee2.id, insertedEmployee3.id],
      });
      await db.delete(emplyeeTable, qb);
    });

    test('CRUD operations with undefined values', async () => {
      const testEmployee1: Omit<Employee, keyof Record> = { name: 'Veronica', jobTitle: 'Software Engineer' };
      const testEmployee2: Omit<Employee, keyof Record> = { name: 'Brent', jobTitle: undefined };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();

      // Insert operation with undefined values
      await expect(db.insert(emplyeeTable, testEmployee2)).rejects.toThrow();

      // Insert valid employee
      const insertedEmployee1 = await db.insert(emplyeeTable, testEmployee1);

      // Attempt to build query with undefined value
      expect(() => {
        new QueryBuilder<Employee>(emplyeeTable.name).condition({ field: 'jobTitle', operator: '=', value: undefined });
      }).toThrow();

      // Attempt to query
      await expect(db.query(emplyeeTable, { id: insertedEmployee1, jobTitle: undefined })).rejects.toThrow();

      // Update operation with undefined values
      await expect(db.update(emplyeeTable, { id: insertedEmployee1.id, jobTitle: undefined })).rejects.toThrow();

      // Attempt to delete
      await expect(db.delete(emplyeeTable, { id: insertedEmployee1, jobTitle: undefined })).rejects.toThrow();

      // Clean up
      const deleteValidQuery = new QueryBuilder<Employee>(emplyeeTable.name).condition({
        field: 'id',
        operator: 'IN',
        value: [insertedEmployee1.id],
      });
      await db.delete(emplyeeTable, deleteValidQuery);
    });

    test('Insert with reserved words', async () => {
      const testRecord: Omit<ReservedWordTest, keyof Record> = { name: 'Test Name', order: '1', select: 'Option 1' };
      const table: Table<ReservedWordTest> = new ReservedWordTestTable();
      const insertedRecord = await db.insert(table, testRecord);
      const fetchedRecord = await db.get(table, { id: insertedRecord.id });
      expect(fetchedRecord).toBeTruthy();
      await db.delete(table, { id: fetchedRecord.id });
    });

    test('Update with reserved words', async () => {
      const testRecord: Omit<ReservedWordTest, keyof Record> = { name: 'Test Name', order: '1', select: 'Option 1' };
      const table: Table<ReservedWordTest> = new ReservedWordTestTable();
      const insertedRecord = await db.insert(table, testRecord);
      const updateCount = await db.update(
        table,
        {
          name: 'Updated Name',
          order: '2',
          join: 'Join Option',
        },
        { id: insertedRecord.id }
      );
      expect(updateCount).toBe(1);
      const fetchedRecord = await db.get(table, { id: insertedRecord.id });
      expect(fetchedRecord.name).toBe('Updated Name');
      expect(fetchedRecord.order).toBe('2');
      expect(fetchedRecord.join).toBe('Join Option');
      await db.delete(table, { id: fetchedRecord.id });
    });

    test('Delete with reserved words', async () => {
      const testRecord: Omit<ReservedWordTest, keyof Record> = { name: 'Test Name', order: '1', select: 'Option 1' };
      const table: Table<ReservedWordTest> = new ReservedWordTestTable();
      const insertedRecord = await db.insert(table, testRecord);
      let fetchedRecord = await db.get(table, { id: insertedRecord.id });
      expect(fetchedRecord).toBeTruthy();
      const deleteCount = await db.delete(table, { id: fetchedRecord.id });
      expect(deleteCount).toBe(1);
      fetchedRecord = await db.get(table, { id: insertedRecord.id });
      expect(fetchedRecord).toBeFalsy();
    });

    test('Query with reserved words', async () => {
      const testRecord1: Omit<ReservedWordTest, keyof Record> = { name: 'Test Name 1', order: '1', select: 'Option 1' };
      const testRecord2: Omit<ReservedWordTest, keyof Record> = { name: 'Test Name 2', order: '1', select: 'Option 1' };
      const testRecord3: Omit<ReservedWordTest, keyof Record> = { name: 'Test Name 3', order: '2', select: 'Option 2' };
      const table: Table<ReservedWordTest> = new ReservedWordTestTable();
      const insertedRecord1 = await db.insert(table, testRecord1);
      const insertedRecord2 = await db.insert(table, testRecord2);
      const insertedRecord3 = await db.insert(table, testRecord3);
      const fetchedRecords = await db.query(table, { order: '1', select: 'Option 1' });
      expect(fetchedRecords.length).toBe(2);
      expect(fetchedRecords[0].name).toBe('Test Name 1');
      expect(fetchedRecords[1].name).toBe('Test Name 2');
      const qb = new QueryBuilder<ReservedWordTest>(table.name).condition({
        field: 'id',
        operator: 'IN',
        value: [insertedRecord1.id, insertedRecord2.id, insertedRecord3.id],
      });
      await db.delete(table, qb);
    });

    test('Query with sort and reserved words', async () => {
      const testRecord1: Omit<ReservedWordTest, keyof Record> = { name: 'Test Name 1', order: '1', select: 'Option 1' };
      const testRecord2: Omit<ReservedWordTest, keyof Record> = { name: 'Test Name 2', order: '2', select: 'Option 2' };
      const testRecord3: Omit<ReservedWordTest, keyof Record> = { name: 'Test Name 3', order: '3', select: 'Option 3' };
      const table: Table<ReservedWordTest> = new ReservedWordTestTable();

      const insertedRecord1 = await db.insert(table, testRecord1);
      const insertedRecord2 = await db.insert(table, testRecord2);
      const insertedRecord3 = await db.insert(table, testRecord3);

      const sortQuery = new QueryBuilder<ReservedWordTest>(table.name).sort([
        { field: 'order', byValues: ['1', '2', '3'] },
      ]);
      const sortResults = await db.query(table, sortQuery);

      // Assertions
      expect(sortResults.length).toBe(3);
      expect(sortResults[0].order).toBe('1');
      expect(sortResults[1].order).toBe('2');
      expect(sortResults[2].order).toBe('3');

      // Clean up
      const qb = new QueryBuilder<ReservedWordTest>(table.name).condition({
        field: 'id',
        operator: 'IN',
        value: [insertedRecord1.id, insertedRecord2.id, insertedRecord3.id],
      });
      await db.delete(table, qb);
    });

    test('Query with reserved words and subquery', async () => {
      const testRecord1: Omit<ReservedWordTest, keyof Record> = { name: 'Test Name 1', order: '1', select: 'Option 1' };
      const testRecord2: Omit<ReservedWordTest, keyof Record> = { name: 'Test Name 2', order: '2', select: 'Option 2' };
      const table: Table<ReservedWordTest> = new ReservedWordTestTable();

      const insertedRecord1 = await db.insert(table, testRecord1);
      const insertedRecord2 = await db.insert(table, testRecord2);

      const subQb = new QueryBuilder<ReservedWordTest>(table.name).select({ fields: ['id'] }).condition({
        field: 'select',
        operator: '=',
        value: 'Option 1',
      });

      const qb = new QueryBuilder<ReservedWordTest>(table.name).condition({
        field: 'id',
        operator: 'IN',
        value: subQb,
      });

      // Execute the query
      const results = await db.query(table, qb);
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('Test Name 1');

      // Clean up
      await db.delete(table, { id: insertedRecord1.id });
      await db.delete(table, { id: insertedRecord2.id });
    }, 10000);

    test('Case sensitivity', async () => {
      const testEmployee: Omit<Employee, keyof Record> = {
        name: 'Veronica',
        jobTitle: 'Software ENGINEER',
        isRemote: true,
        startDate: new Date('2024-04-01T00:00:00Z'),
      };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();
      const insertedEmployee = await db.insert(emplyeeTable, testEmployee);

      const queryNameInsensitive = new QueryBuilder<Employee>(emplyeeTable.name).condition(
        {
          field: 'jobTitle',
          operator: '=',
          value: 'SOFTWARE engineer',
        },
        undefined,
        false
      );
      const nameResultsIns = await db.query(emplyeeTable, queryNameInsensitive);
      expect(nameResultsIns.length).toBe(1);

      const queryNameSensitive = new QueryBuilder<Employee>(emplyeeTable.name).condition({
        field: 'jobTitle',
        operator: '=',
        value: 'SOFTWARE ENGINEER',
      });
      const nameResultsSens = await db.query(emplyeeTable, queryNameSensitive);
      expect(nameResultsSens.length).toBe(0);

      await db.delete(emplyeeTable, { id: insertedEmployee.id });
    });
  };
};
