import { transactionTests, getTransactionTestTable, Table } from '@proteinjs/db';
import { KnexDriver } from '../src/KnexDriver';

const dropTable = async (knexDriver: KnexDriver, table: Table<any>) => {
  if (await knexDriver.getKnex().schema.withSchema(knexDriver.getDbName()).hasTable(table.name)) {
    await knexDriver.getKnex().schema.withSchema(knexDriver.getDbName()).dropTable(table.name);
  }
};

const knexDriver = new KnexDriver(
  {
    host: 'localhost',
    user: 'root',
    password: '',
    dbName: 'test',
  },
  getTransactionTestTable
);

describe(
  'Transaction Tests',
  transactionTests(knexDriver, (table) => dropTable(knexDriver, table))
);