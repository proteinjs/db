import { QueryBuilder } from '@proteinjs/db-query';
import { DbDriver, Db } from '../src/Db';
import { withRecordColumns, Record } from '../src/Record';
import { BooleanColumn, StringColumn } from '../src/Columns';
import { Table } from '../src/Table';

export interface Employee extends Record {
  name: string;
  departmentArea?: string | null;
  isRemote?: boolean;
  object?: string;
}

export class EmployeeTable extends Table<Employee> {
  name = 'db_test_employee';
  columns = withRecordColumns<Employee>({
    name: new StringColumn('name'),
    departmentArea: new StringColumn('department_area'),
    isRemote: new BooleanColumn('is_remote'),
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
          departmentArea: 'Cake Factory',
          object:
            '{"cookie":{"originalMaxAge":5184000000,"expires":"2024-07-08T06:16:07.134Z","httpOnly":true,"path":"/"},"passport":{"user":"brent@n3xa.io"}}',
        },
        { id: insertedEmployee.id }
      );
      expect(updateCount).toBe(1);
      const fetchedEmployee = await db.get(emplyeeTable, { id: insertedEmployee.id });
      expect(fetchedEmployee.name).toBe('Veronican');
      expect(fetchedEmployee.departmentArea).toBe('Cake Factory');
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
      const testEmployee1: Omit<Employee, keyof Record> = { name: 'Veronica', departmentArea: 'Cake Factory' };
      const testEmployee2: Omit<Employee, keyof Record> = { name: 'Brent', departmentArea: 'Cake Factory' };
      const testEmployee3: Omit<Employee, keyof Record> = { name: 'Sean', departmentArea: 'Pug Playhouse' };
      const emplyeeTable: Table<Employee> = new EmployeeTable();
      const fetchedEmployee1 = await db.insert(emplyeeTable, testEmployee1);
      const fetchedEmployee2 = await db.insert(emplyeeTable, testEmployee2);
      const fetchedEmployee3 = await db.insert(emplyeeTable, testEmployee3);
      const fetchedEmployees = await db.query(emplyeeTable, { departmentArea: 'Cake Factory' });
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
      const testEmployee1: Omit<Employee, keyof Record> = { name: 'Veronica', departmentArea: 'Cake Factory' };
      const testEmployee2: Omit<Employee, keyof Record> = { name: 'Brent', departmentArea: 'Cake Factory' };
      const testEmployee3: Omit<Employee, keyof Record> = { name: 'Sean', departmentArea: 'Pug Playhouse' };
      const emplyeeTable: Table<Employee> = new EmployeeTable();
      const fetchedEmployee1 = await db.insert(emplyeeTable, testEmployee1);
      const fetchedEmployee2 = await db.insert(emplyeeTable, testEmployee2);
      const fetchedEmployee3 = await db.insert(emplyeeTable, testEmployee3);
      const rowCount = await db.getRowCount(emplyeeTable, { departmentArea: 'Cake Factory' });
      expect(rowCount).toBe(2);
      const qb = new QueryBuilder<Employee>(emplyeeTable.name).condition({
        field: 'id',
        operator: 'IN',
        value: [fetchedEmployee1.id, fetchedEmployee2.id, fetchedEmployee3.id],
      });
      await db.delete(emplyeeTable, qb);
    });

    test('Insert with null values', async () => {
      const testEmployee: Omit<Employee, keyof Record> = { name: 'Zenyatta', departmentArea: null, isRemote: false };
      const emplyeeTable: Table<Employee> = new EmployeeTable();
      const insertedEmployee = await db.insert(emplyeeTable, testEmployee);
      const fetchedEmployee = await db.get(emplyeeTable, { id: insertedEmployee.id });

      expect(fetchedEmployee).toBeTruthy();
      expect(fetchedEmployee.departmentArea).toBeNull();

      const nullUpdateCount = await db.update(emplyeeTable, { departmentArea: null }, { id: insertedEmployee.id });
      expect(nullUpdateCount).toBe(1);
      await db.delete(emplyeeTable, { id: fetchedEmployee.id });
    });

    test('Update with null values', async () => {
      const testEmployee: Omit<Employee, keyof Record> = {
        name: 'Cassidy',
        departmentArea: 'Sharpshooting Cowboys',
        isRemote: false,
      };
      const emplyeeTable: Table<Employee> = new EmployeeTable();
      const insertedEmployee = await db.insert(emplyeeTable, testEmployee);
      const fetchedEmployee = await db.get(emplyeeTable, { id: insertedEmployee.id });
      expect(fetchedEmployee).toBeTruthy();

      const nullUpdateCount = await db.update(emplyeeTable, { departmentArea: null }, { id: insertedEmployee.id });
      expect(nullUpdateCount).toBe(1);
      await db.delete(emplyeeTable, { id: fetchedEmployee.id });
    });

    test('Query with null values', async () => {
      const testEmployee: Omit<Employee, keyof Record> = {
        name: 'Cassidy',
        departmentArea: null,
        isRemote: false,
      };
      const emplyeeTable: Table<Employee> = new EmployeeTable();
      const insertedEmployee = await db.insert(emplyeeTable, testEmployee);

      const qb = new QueryBuilder<Employee>(emplyeeTable.name)
        .condition({
          field: 'departmentArea',
          operator: 'IS NULL',
        })
        .condition({ field: 'id', operator: '=', value: insertedEmployee.id });
      const rows = await db.query(emplyeeTable, qb);
      expect(rows.length).toEqual(1);
      await db.delete(emplyeeTable, { id: insertedEmployee.id });
    });
  };
};
