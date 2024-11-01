import { transactionTests, getTransactionTestTable } from '@proteinjs/db';
import { SpannerDriver } from '../src/SpannerDriver';
import { getDropTestTable } from './dropTestTable';

const spannerDriver = new SpannerDriver(
  {
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  },
  getTransactionTestTable
);

describe('Transaction Tests', transactionTests(spannerDriver, getDropTestTable(spannerDriver)));
