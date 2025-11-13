import { transactionTests } from '@proteinjs/db/test';
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

describe('Transaction Tests', transactionTests(knexDriver, new TransactionContext(), getDropTestTable(knexDriver)));
