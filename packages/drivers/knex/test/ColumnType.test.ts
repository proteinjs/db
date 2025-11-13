import { columnTypeTests } from '@proteinjs/db/test';
import { KnexDriver } from '../src/KnexDriver';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';
import '../generated/test/index';

const knexDriver = new KnexDriver({
  host: 'localhost',
  user: 'root',
  password: '',
  dbName: 'test',
});

describe('Column Type Tests', columnTypeTests(knexDriver, new TransactionContext(), getDropTestTable(knexDriver)));
