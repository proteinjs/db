import {
  BinaryColumn,
  BooleanColumn,
  DateColumn,
  DateTimeColumn,
  DecimalColumn,
  FloatColumn,
  IntegerColumn,
  ObjectColumn,
  StringColumn,
  UuidColumn,
  Record,
  withRecordColumns,
  Table,
} from '@proteinjs/db';

export interface User extends Record {
  name: string;
  email: string;
  active: boolean;
}

export class UserTestTable extends Table<User> {
  name = 'db_test_user';
  columns = withRecordColumns<User>({
    name: new StringColumn('name'),
    email: new StringColumn('email'),
    active: new BooleanColumn('active'),
  });
  indexes = [
    { name: 'db_test_user_email_index', columns: ['email'] as (keyof User)[] },
    { name: 'db_test_user_active_email_index', columns: ['active', 'email'] as (keyof User)[] },
  ];
}

export interface MappedIndexUser extends Record {
  emailAddress: string;
  accountStatus: string;
  createdOn: Date;
}

export class MappedIndexUserTable extends Table<MappedIndexUser> {
  name = 'db_test_tm_mapped_index_user';
  columns = withRecordColumns<MappedIndexUser>({
    emailAddress: new StringColumn('email_address'),
    accountStatus: new StringColumn('account_status'),
    createdOn: new DateColumn('created_on'),
  });
  indexes = [
    {
      name: 'db_test_mapped_index_user_email_index',
      columns: ['emailAddress'] as (keyof MappedIndexUser)[],
    },
    {
      name: 'db_test_mapped_index_user_status_email_index',
      columns: ['accountStatus', 'emailAddress'] as (keyof MappedIndexUser)[],
    },
  ];
}

export interface ColumnTypes extends Record {
  integer: number;
  bigInteger: number;
  text: string;
  string: string;
  float: number;
  decimal: number;
  boolean: boolean;
  date: Date;
  dateTime: moment.Moment;
  binary: boolean;
  object: any;
  uuid: string;
}

export class ColumnTypesTable extends Table<ColumnTypes> {
  name = 'db_test_tm_column_types';
  columns = withRecordColumns<ColumnTypes>({
    integer: new IntegerColumn('integer', { nullable: true }),
    bigInteger: new IntegerColumn('big_integer', { nullable: false }, true),
    string: new StringColumn('string', { references: { table: 'db_test_user' } }),
    text: new StringColumn('text', undefined, 'MAX'),
    float: new FloatColumn('float', { defaultValue: async () => 0.5 }),
    decimal: new DecimalColumn('decimal'),
    boolean: new BooleanColumn('boolean'),
    date: new DateColumn('date'),
    dateTime: new DateTimeColumn('date_time'),
    binary: new BinaryColumn('binary'),
    object: new ObjectColumn('object'),
    uuid: new UuidColumn('uuid', { unique: { unique: true } }),
  });
}

export const tableManagerTestTables = {
  User: new UserTestTable() as Table<User>,
  MappedIndexUser: new MappedIndexUserTable() as Table<MappedIndexUser>,
  ColumnTypes: new ColumnTypesTable() as Table<ColumnTypes>,
};
