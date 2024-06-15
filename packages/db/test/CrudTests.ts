import { QueryBuilder } from '@proteinjs/db-query';
import { DbDriver, Db } from '../src/Db';
import { withRecordColumns, Record } from '../src/Record';
import { BooleanColumn, StringColumn } from '../src/Columns';
import { Table } from '../src/Table';
import { log } from 'console';

export interface Employee extends Record {
  name: string;
  department?: string;
  jobTitle?: string | null;
  isRemote?: boolean;
  object?: string;
}

export class EmployeeTable extends Table<Employee> {
  name = 'db_test_employee';
  columns = withRecordColumns<Employee>({
    name: new StringColumn('name'),
    department: new StringColumn('department'),
    isRemote: new BooleanColumn('is_remote'),
    jobTitle: new StringColumn('job_title'),
    object: new StringColumn('object'),
  });
}

/**
 * Used for testing purposes only.
 *  */
export const getTestTable = (tableName: string) => {
  const employeeTable = new EmployeeTable();
  if (employeeTable.name == tableName) {
    return employeeTable;
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

      await driver.getTableManager().loadTable(new EmployeeTable());
    });

    afterAll(async () => {
      await dropTable(new EmployeeTable());

      if (driver.stop) {
        await driver.stop();
      }
    });

    test('Insert', async () => {
      const testEmployee: Omit<Employee, keyof Record> = { name: 'Veronica' };
      const emplyeeTable: Table<Employee> = new EmployeeTable();
      const insertedEmployee = await db.insert(emplyeeTable, testEmployee);
      const fetchedEmployee = await db.get(emplyeeTable, { id: insertedEmployee.id });
      expect(fetchedEmployee).toBeTruthy();
      await db.delete(emplyeeTable, { id: fetchedEmployee.id });
    });

    test('Update', async () => {
      const testEmployee: Omit<Employee, keyof Record> = { name: 'Veronica' };
      const emplyeeTable: Table<Employee> = new EmployeeTable();
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
      const emplyeeTable: Table<Employee> = new EmployeeTable();
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
      const emplyeeTable: Table<Employee> = new EmployeeTable();
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
      const emplyeeTable: Table<Employee> = new EmployeeTable();
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
      const emplyeeTable: Table<Employee> = new EmployeeTable();
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
      const emplyeeTable: Table<Employee> = new EmployeeTable();
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
      const emplyeeTable: Table<Employee> = new EmployeeTable();
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
      const emplyeeTable: Table<Employee> = new EmployeeTable();
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
  };
};
