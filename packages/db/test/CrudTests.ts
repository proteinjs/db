import { QueryBuilder } from '@proteinjs/db-query';
import { DbDriver, Db } from '../src/Db';
import { withRecordColumns, Record } from '../src/Record';
import { StringColumn } from '../src/Columns';
import { Table } from '../src/Table';

export interface Employee extends Record {
  name: string;
  department?: string;
  object?: string;
}

export class EmployeeTable extends Table<Employee> {
  name = 'db_test_employee';
  columns = withRecordColumns<Employee>({
    name: new StringColumn('name'),
    department: new StringColumn('department'),
    object: new StringColumn('object'),
  });
}

export const crudTests = (driver: DbDriver, dropTable: (table: Table<any>) => Promise<void>) => {
  return () => {
    const getTable = (tableName: string) => {
      const employeeTable = new EmployeeTable();
      if (employeeTable.name == tableName) {
        return employeeTable;
      }

      throw new Error('Cannot find test table');
    };
    const db = new Db(driver, getTable);

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
  };
};
