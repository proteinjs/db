import { withRecordColumns, Record, BooleanColumn, DateColumn, StringColumn, Table } from '@proteinjs/db';

export interface TransactionEmployee extends Record {
  name: string;
  department?: string;
  jobTitle?: string | null;
  isRemote?: boolean;
  startDate?: Date;
  object?: string;
}

export class TransactionEmployeeTestTable extends Table<TransactionEmployee> {
  name = 'db_test_transaction_employee';
  columns = withRecordColumns<TransactionEmployee>({
    name: new StringColumn('name'),
    department: new StringColumn('department'),
    isRemote: new BooleanColumn('is_remote'),
    jobTitle: new StringColumn('job_title'),
    startDate: new DateColumn('start_date'),
    object: new StringColumn('object'),
  });
}

export interface TransactionReservedWordTest extends Record {
  name: string;
  order?: string;
  select?: string;
  join?: string;
}

export class TransactionReservedWordTestTable extends Table<TransactionReservedWordTest> {
  name = 'db_test_transaction_reserved_word';
  columns = withRecordColumns<TransactionReservedWordTest>({
    name: new StringColumn('name'),
    order: new StringColumn('order'),
    select: new StringColumn('select'),
    join: new StringColumn('join'),
  });
}

export const transactionTestTables = {
  TransactionEmployee: new TransactionEmployeeTestTable() as Table<TransactionEmployee>,
  TransactionReservedWord: new TransactionReservedWordTestTable() as Table<TransactionReservedWordTest>,
};
