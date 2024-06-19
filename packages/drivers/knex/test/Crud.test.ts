import { Table, columnTypeTests, crudTests } from '@proteinjs/db';
import { KnexDriver } from '../src/KnexDriver';

const dropTable = async (table: Table<any>) => {
  if (await knexDriver.getKnex().schema.withSchema(knexDriver.getDbName()).hasTable(table.name)) {
    await knexDriver.getKnex().schema.withSchema(knexDriver.getDbName()).dropTable(table.name);
  }
};

const knexDriver = new KnexDriver({
  host: 'localhost',
  user: 'root',
  password: '',
  dbName: 'test',
});

describe('CRUD Tests', crudTests(knexDriver, dropTable));

const knexDriverColumnTypeTests = new KnexDriver({
  host: 'localhost',
  user: 'root',
  password: '',
  dbName: 'test',
});

describe('Column Type Tests', columnTypeTests(knexDriverColumnTypeTests, dropTable));
