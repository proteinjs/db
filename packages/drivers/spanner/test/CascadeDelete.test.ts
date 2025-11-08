import { cascadeDeleteTests } from '@proteinjs/db';
import { SpannerDriver } from '../src/SpannerDriver';
import { getDropTestTable } from './util/dropTestTable';
import { TransactionContext } from '@proteinjs/db-transaction-context';
require('@proteinjs/db/test');
require('../generated/test/index');

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

describe(
  'Cascade Delete Tests',
  cascadeDeleteTests(spannerDriver, new TransactionContext(), getDropTestTable(spannerDriver))
);
