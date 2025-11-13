import { crudTests } from '@proteinjs/db/test';
import { KnexDriver } from '@proteinjs/db-driver-knex';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';
import '../generated/test/index';

const knexDriver = new KnexDriver({
  host: 'localhost',
  user: 'root',
  password: '',
  dbName: 'test',
});

describe('CRUD Tests', crudTests(knexDriver, new TransactionContext(), getDropTestTable(knexDriver)));
