import { transactionTests, getTransactionTestTable } from '@proteinjs/db';
import { KnexDriver } from '../src/KnexDriver';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';

const knexDriver = new KnexDriver(
  {
    host: 'localhost',
    user: 'root',
    password: '',
    dbName: 'test',
  },
  getTransactionTestTable
);

describe('Transaction Tests', transactionTests(knexDriver, new TransactionContext(), getDropTestTable(knexDriver)));
