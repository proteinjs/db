import { withRecordColumns, Record, BooleanColumn, DateColumn, StringColumn, Table } from '@proteinjs/db';

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

export const crudTestTables = {
  Employee: new EmployeeTestTable() as Table<Employee>,
  ReservedWordTest: new ReservedWordTestTable() as Table<ReservedWordTest>,
};
