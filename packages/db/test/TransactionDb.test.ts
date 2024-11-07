import moment from 'moment';
import { Transaction } from '../src/transaction/Transaction';
import { Table } from '../src/Table';
import { Record, withRecordColumns } from '../src/Record';
import { StringColumn, BooleanColumn, DateColumn } from '../src/Columns';

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

describe('Transaction db', () => {
  const employeeTable = new EmployeeTestTable() as Table<Employee>;
  let transaction: Transaction;
  let insertCallback: jest.Mock;
  let updateCallback: jest.Mock;
  let deleteCallback: jest.Mock;

  beforeEach(() => {
    insertCallback = jest.fn();
    updateCallback = jest.fn();
    deleteCallback = jest.fn();
    transaction = new Transaction(insertCallback, updateCallback, deleteCallback);
  });

  describe('insert', () => {
    it('should add record to cached db and queue insert operation', async () => {
      const record: Partial<Employee> = {
        name: 'John Doe',
        department: 'Engineering',
        jobTitle: 'Software Engineer',
        isRemote: true,
        startDate: new Date('2024-01-01'),
      };

      const result = await transaction.insert(employeeTable, record);

      // Verify record was added to cache
      expect(transaction.recordMap(employeeTable.name)[result.id]).toEqual({
        id: expect.any(String),
        name: 'John Doe',
        department: 'Engineering',
        jobTitle: 'Software Engineer',
        isRemote: true,
        startDate: expect.any(Date),
        created: expect.any(moment),
        updated: expect.any(moment),
      });

      // Verify operation was queued
      expect(transaction.ops).toHaveLength(1);
      expect(transaction.ops[0]).toEqual({
        name: 'insert',
        args: [employeeTable, result],
      });

      // Verify callback was called
      expect(insertCallback).toHaveBeenCalledTimes(1);
      expect(insertCallback).toHaveBeenCalledWith(employeeTable, result);
    });

    it('should throw error when inserting record with duplicate id', async () => {
      const record: Partial<Employee> = {
        id: 'test-id',
        name: 'John Doe',
        department: 'Engineering',
      };
      await transaction.insert(employeeTable, record);

      await expect(transaction.insert(employeeTable, record)).rejects.toThrow(
        'Attempting to insert with duplicate id: test-id, record already exists'
      );
    });
  });

  describe('update', () => {
    it('should update record in cached db by id and queue update operation', async () => {
      // First insert a record
      const original = await transaction.insert(employeeTable, {
        name: 'John Doe',
        department: 'Engineering',
        isRemote: true,
      });

      // Update the record
      const updates = {
        id: original.id,
        department: 'Product',
        jobTitle: 'Product Manager',
      };
      transaction.update(employeeTable, updates);

      // Verify cache was updated
      const cached = transaction.recordMap(employeeTable.name)[original.id];
      expect(cached).toEqual({
        id: original.id,
        name: 'John Doe',
        department: 'Product',
        jobTitle: 'Product Manager',
        isRemote: true,
        created: expect.any(moment),
        updated: expect.any(moment),
      });

      // Verify operation was queued
      expect(transaction.ops[1]).toEqual({
        name: 'update',
        args: [employeeTable, updates],
      });

      // Verify callback was called
      expect(updateCallback).toHaveBeenCalledTimes(1);
      expect(updateCallback).toHaveBeenCalledWith(
        employeeTable,
        {
          id: original.id,
          name: 'John Doe',
          department: 'Engineering',
          isRemote: true,
          created: expect.any(moment),
          updated: expect.any(moment),
        },
        cached
      );
    });

    it('should update records in cached db by object query and queue update operation', async () => {
      // Insert two records
      await transaction.insert(employeeTable, {
        name: 'John Doe',
        department: 'Engineering',
        isRemote: true,
      });
      await transaction.insert(employeeTable, {
        name: 'Jane Doe',
        department: 'Engineering',
        isRemote: false,
      });

      // Update all records in Engineering department
      const updates = { jobTitle: 'Software Engineer' };
      transaction.update(employeeTable, updates, { department: 'Engineering' });

      // Verify all matching records were updated in cache
      const cachedRecords = Object.values(transaction.recordMap(employeeTable.name));
      cachedRecords.forEach((record) => {
        expect(record.jobTitle).toBe('Software Engineer');
      });

      // Verify operation was queued
      expect(transaction.ops[2]).toEqual({
        name: 'update',
        args: [employeeTable, updates, { department: 'Engineering' }],
      });
    });

    it('should not throw when updating non-existent record by id', () => {
      const update = { id: 'non-existent', name: 'John' };

      expect(() => transaction.update(employeeTable, update)).not.toThrow();
    });
  });

  describe('delete', () => {
    it('should remove record from cached db by id and queue delete operation', async () => {
      const record = await transaction.insert(employeeTable, {
        name: 'John Doe',
        department: 'Engineering',
      });

      transaction.delete(employeeTable, { id: record.id });

      expect(transaction.recordMap(employeeTable.name)[record.id]).toBeUndefined();
      expect(transaction.ops[1]).toEqual({
        name: 'delete',
        args: [employeeTable, { id: record.id }],
      });
      expect(deleteCallback).toHaveBeenCalledTimes(1);
      expect(deleteCallback).toHaveBeenCalledWith(employeeTable, record);
    });

    it('should remove records from cached db by object query and queue delete operation', async () => {
      await transaction.insert(employeeTable, {
        name: 'John Doe',
        department: 'Engineering',
        isRemote: true,
      });
      await transaction.insert(employeeTable, {
        name: 'Jane Doe',
        department: 'Engineering',
        isRemote: true,
      });

      transaction.delete(employeeTable, { department: 'Engineering' });

      const cachedRecords = Object.values(transaction.recordMap(employeeTable.name));
      expect(cachedRecords).toHaveLength(0);
      expect(transaction.ops[2]).toEqual({
        name: 'delete',
        args: [employeeTable, { department: 'Engineering' }],
      });
    });
  });

  describe('cache integrity', () => {
    it('should preserve unspecified fields during partial updates', async () => {
      // Insert a record with multiple fields
      const record = await transaction.insert(employeeTable, {
        name: 'John Doe',
        department: 'Engineering',
        jobTitle: 'Software Engineer',
        isRemote: true,
        startDate: new Date('2024-01-01'),
      });

      // Perform a partial update
      transaction.update(employeeTable, {
        id: record.id,
        department: 'Product',
      });

      // Verify that only the specified field was updated and others remain unchanged
      const cached = transaction.recordMap(employeeTable.name)[record.id];
      expect(cached).toEqual({
        id: record.id,
        name: 'John Doe',
        department: 'Product', // Only this field should change
        jobTitle: 'Software Engineer',
        isRemote: true,
        startDate: expect.any(Date),
        created: expect.any(moment),
        updated: expect.any(moment),
      });
    });

    it('should maintain referential integrity in the cache across operations', async () => {
      // Insert initial record
      const record = await transaction.insert(employeeTable, {
        name: 'John Doe',
        department: 'Engineering',
      });

      // Get a reference to the cached record
      const initialCacheRef = transaction.recordMap(employeeTable.name)[record.id];

      // Store references to verify they stay up to date
      const references = [initialCacheRef, transaction.recordMap(employeeTable.name)[record.id]];

      // Perform multiple updates
      transaction.update(employeeTable, {
        id: record.id,
        jobTitle: 'Software Engineer',
      });

      transaction.update(employeeTable, {
        id: record.id,
        isRemote: true,
      });

      // Get another reference after updates
      references.push(transaction.recordMap(employeeTable.name)[record.id]);

      // All references should point to the same, updated object
      const expectedState = {
        id: record.id,
        name: 'John Doe',
        department: 'Engineering',
        jobTitle: 'Software Engineer',
        isRemote: true,
        created: expect.any(moment),
        updated: expect.any(moment),
      };

      // Verify all references have the same, updated state
      references.forEach((ref) => {
        expect(ref).toEqual(expectedState);
      });

      // Verify all references point to the exact same object
      references.forEach((ref) => {
        expect(ref).toBe(initialCacheRef);
      });
    });

    it('should maintain referential integrity when updating via query', async () => {
      // Insert records
      const record = await transaction.insert(employeeTable, {
        name: 'John Doe',
        department: 'Engineering',
        isRemote: true,
      });

      // Get initial reference
      const initialRef = transaction.recordMap(employeeTable.name)[record.id];

      // Update via query
      transaction.update(employeeTable, { jobTitle: 'Remote Engineer' }, { department: 'Engineering', isRemote: true });

      // Get new reference
      const currentRef = transaction.recordMap(employeeTable.name)[record.id];

      // Verify both references point to the same object
      expect(currentRef).toBe(initialRef);

      // Verify the object was updated correctly
      expect(currentRef).toEqual({
        id: record.id,
        name: 'John Doe',
        department: 'Engineering',
        isRemote: true,
        jobTitle: 'Remote Engineer',
        created: expect.any(moment),
        updated: expect.any(moment),
      });
    });
  });
});
