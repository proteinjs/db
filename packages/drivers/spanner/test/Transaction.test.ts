import { transactionTests } from '@proteinjs/db/test';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { getDropTestTable } from './util/getDropTestTable';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import '../generated/test/index';

const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};

const spannerDriver = new SpannerDriver(spannerConfig);

describe(
  'Transaction Tests',
  transactionTests(spannerDriver, new TransactionContext(), getDropTestTable(spannerDriver))
);
