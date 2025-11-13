import { cascadeDeleteTests } from '@proteinjs/db/test';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { getDropTestTable } from './util/getDropTestTable';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import '../generated/test/index';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

describe(
  'Cascade Delete Tests',
  cascadeDeleteTests(spannerDriver, new TransactionContext(), getDropTestTable(spannerDriver))
);
