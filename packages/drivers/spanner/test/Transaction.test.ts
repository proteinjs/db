import { transactionTests, getTransactionTestTable } from '@proteinjs/db';
import { SpannerDriver } from '../src/SpannerDriver';
import { getDropTestTable } from './util/dropTestTable';
import { TransactionContext } from '@proteinjs/db-transaction-context';

const spannerDriver = new SpannerDriver(
  {
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  },
  getTransactionTestTable
);

describe(
  'Transaction Tests',
  transactionTests(spannerDriver, new TransactionContext(), getDropTestTable(spannerDriver))
);
