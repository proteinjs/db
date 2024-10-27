import {
  Table,
  columnTypeTests,
  crudTests,
  getColTypeTestTable,
  getCrudTestTable,
  getDynamicReferenceColumnTestTable,
  dynamicReferenceColumnTests,
} from '@proteinjs/db';
import { KnexDriver } from '../src/KnexDriver';

const dropTable = async (knexDriver: KnexDriver, table: Table<any>) => {
  if (await knexDriver.getKnex().schema.withSchema(knexDriver.getDbName()).hasTable(table.name)) {
    await knexDriver.getKnex().schema.withSchema(knexDriver.getDbName()).dropTable(table.name);
  }
};

const knexDriverColumnTypesTests = new KnexDriver(
  {
    host: 'localhost',
    user: 'root',
    password: '',
    dbName: 'test',
  },
  getColTypeTestTable
);

describe(
  'Column Type Tests',
  columnTypeTests(knexDriverColumnTypesTests, (table) => dropTable(knexDriverColumnTypesTests, table))
);

const knexDriverDynamicRefCol = new KnexDriver(
  {
    host: 'localhost',
    user: 'root',
    password: '',
    dbName: 'test',
  },
  getDynamicReferenceColumnTestTable
);

describe(
  'DynamicReferenceColumn Tests',
  dynamicReferenceColumnTests(knexDriverDynamicRefCol, (table) => dropTable(knexDriverDynamicRefCol, table))
);

// driver will be stopped in this test, any tests put after this one will not establish connection
const knexDriverCrudTests = new KnexDriver(
  {
    host: 'localhost',
    user: 'root',
    password: '',
    dbName: 'test',
  },
  getCrudTestTable
);

describe(
  'CRUD Tests',
  crudTests(knexDriverCrudTests, (table) => dropTable(knexDriverCrudTests, table))
);
