import { QueryBuilder } from '@proteinjs/db-query';
import { DbDriver, Db } from '../../src/Db';
import { withRecordColumns, Record } from '../../src/Record';
import { BooleanColumn, DateColumn, StringColumn } from '../../src/Columns';
import { Table } from '../../src/Table';

interface Employee extends Record {
  name: string;
  department?: string;
  jobTitle?: string | null;
  isRemote?: boolean;
  startDate?: Date;
  object?: string;
}

class EmployeeTestTable extends Table<Employee> {
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

interface ReservedWordTest extends Record {
  name: string;
  order?: string;
  select?: string;
  join?: string;
}

class ReservedWordTestTable extends Table<ReservedWordTest> {
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
export const getTransactionTestTable = (tableName: string) => {
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

export const transactionTests = (driver: DbDriver, dropTable: (table: Table<any>) => Promise<void>) => {
  return () => {
    const db = new Db(driver, getTransactionTestTable);

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

    test('Transaction with successful operations', async () => {
      const testEmployee1: Omit<Employee, keyof Record> = {
        name: 'Veronica',
        department: 'Engineering',
      };
      const testEmployee2: Omit<Employee, keyof Record> = {
        name: 'Brent',
        department: 'Engineering',
      };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();

      // Execute multiple operations in a transaction
      const results = await db.runTransaction(async () => {
        const emp1 = await db.insert(emplyeeTable, testEmployee1);
        const emp2 = await db.insert(emplyeeTable, testEmployee2);
        await db.update(emplyeeTable, { department: 'R&D' }, { id: emp1.id });
        return { emp1, emp2 };
      });

      // Verify the transaction results
      expect(results.emp1.name).toBe('Veronica');
      expect(results.emp2.name).toBe('Brent');

      // Verify the records in the database
      const updatedEmp1 = await db.get(emplyeeTable, { id: results.emp1.id });
      const updatedEmp2 = await db.get(emplyeeTable, { id: results.emp2.id });

      expect(updatedEmp1.department).toBe('R&D');
      expect(updatedEmp2.department).toBe('Engineering');

      // Clean up
      const qb = new QueryBuilder<Employee>(emplyeeTable.name).condition({
        field: 'id',
        operator: 'IN',
        value: [results.emp1.id, results.emp2.id],
      });
      await db.delete(emplyeeTable, qb);
    });

    test('Transaction rollback on error', async () => {
      const testEmployee1: Omit<Employee, keyof Record> = {
        name: 'Veronica',
        department: 'Engineering',
      };
      const testEmployee2: Omit<Employee, keyof Record> = {
        name: 'Brent',
        department: undefined, // This will cause an error
      };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();

      let insertedId: string | undefined;

      // Execute operations that should fail and rollback
      try {
        await db.runTransaction(async () => {
          const emp1 = await db.insert(emplyeeTable, testEmployee1);
          insertedId = emp1.id;
          // This should fail and trigger a rollback
          await db.insert(emplyeeTable, testEmployee2);
          return emp1;
        });
        fail('Transaction should have thrown an error');
      } catch (error) {
        // Verify the first insert was rolled back
        const result = await db.get(emplyeeTable, { id: insertedId });
        expect(result).toBeFalsy();
      }
    });

    test('Nested transactions are not allowed', async () => {
      const testEmployee: Omit<Employee, keyof Record> = {
        name: 'Veronica',
        department: 'Engineering',
      };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();

      await expect(
        db.runTransaction(async () => {
          const emp = await db.insert(emplyeeTable, testEmployee);
          // Try to start a nested transaction
          await db.runTransaction(async () => {
            await db.update(emplyeeTable, { department: 'R&D' }, { id: emp.id });
            return emp;
          });
          return emp;
        })
      ).rejects.toThrow();
    });

    test('Transaction isolation', async () => {
      const testEmployee: Omit<Employee, keyof Record> = {
        name: 'Veronica',
        department: 'Engineering',
      };
      const emplyeeTable: Table<Employee> = new EmployeeTestTable();

      // Start a transaction but don't commit immediately
      const transactionPromise = db.runTransaction(async () => {
        const emp = await db.insert(emplyeeTable, testEmployee);
        // Delay to simulate long-running transaction
        await new Promise((resolve) => setTimeout(resolve, 100));
        return emp;
      });

      // Try to query the record before transaction commits
      const results = await db.query(emplyeeTable, { name: 'Veronica' });
      expect(results.length).toBe(0);

      // Wait for transaction to complete
      const insertedEmployee = await transactionPromise;

      // Clean up
      await db.delete(emplyeeTable, { id: insertedEmployee.id });
    });

    test('Transaction with multiple table operations', async () => {
      const testEmployee: Omit<Employee, keyof Record> = {
        name: 'Veronica',
        department: 'Engineering',
      };
      const testReservedWord: Omit<ReservedWordTest, keyof Record> = {
        name: 'Test',
        order: '1',
        select: 'Option 1',
      };

      const emplyeeTable: Table<Employee> = new EmployeeTestTable();
      const reservedWordTable: Table<ReservedWordTest> = new ReservedWordTestTable();

      // Execute operations on multiple tables in a transaction
      const results = await db.runTransaction(async () => {
        const emp = await db.insert(emplyeeTable, testEmployee);
        const reserved = await db.insert(reservedWordTable, testReservedWord);
        await db.update(emplyeeTable, { department: 'R&D' }, { id: emp.id });
        await db.update(reservedWordTable, { order: '2' }, { id: reserved.id });
        return { emp, reserved };
      });

      // Verify the records in both tables
      const updatedEmp = await db.get(emplyeeTable, { id: results.emp.id });
      const updatedReserved = await db.get(reservedWordTable, { id: results.reserved.id });

      expect(updatedEmp.department).toBe('R&D');
      expect(updatedReserved.order).toBe('2');

      // Clean up
      await db.delete(emplyeeTable, { id: results.emp.id });
      await db.delete(reservedWordTable, { id: results.reserved.id });
    });
  };
};
