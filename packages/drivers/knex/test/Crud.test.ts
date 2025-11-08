import {
  columnTypeTests,
  crudTests,
  getColTypeTestTable,
  getCrudTestTable,
  getDynamicReferenceColumnTestTable,
  dynamicReferenceColumnTests,
} from '@proteinjs/db';
import { KnexDriver } from '../src/KnexDriver';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';

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
  columnTypeTests(knexDriverColumnTypesTests, new TransactionContext(), getDropTestTable(knexDriverColumnTypesTests))
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
  dynamicReferenceColumnTests(knexDriverDynamicRefCol, getDropTestTable(knexDriverDynamicRefCol))
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

describe('CRUD Tests', crudTests(knexDriverCrudTests, new TransactionContext(), getDropTestTable(knexDriverCrudTests)));
