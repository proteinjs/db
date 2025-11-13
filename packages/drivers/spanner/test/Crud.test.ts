import { crudTests } from '@proteinjs/db/test';
import { SpannerDriver } from '../src/SpannerDriver';
import { getDropTestTable } from './util/getDropTestTable';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import '../generated/test/index';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

describe('CRUD Tests', crudTests(spannerDriver, new TransactionContext(), getDropTestTable(spannerDriver)));
