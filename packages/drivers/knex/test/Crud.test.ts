import { Table, crudTests } from '@proteinjs/db';
import { KnexDriver } from '../src/KnexDriver';

const knexDriver = new KnexDriver({
  host: 'localhost',
  user: 'root',
  password: '',
  dbName: 'test',
});
const dropTable = async (table: Table<any>) => {
  if (await knexDriver.getKnex().schema.withSchema(knexDriver.getDbName()).hasTable(table.name)) {
    await knexDriver.getKnex().schema.withSchema(knexDriver.getDbName()).dropTable(table.name);
  }
};

describe('CRUD Tests', crudTests(knexDriver, dropTable));
