import { dynamicReferenceColumnTests } from '@proteinjs/db/test';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { getDropTestTable } from './util/getDropTestTable';
import '../generated/test/index';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

describe('DynamicReferenceColumn Tests', dynamicReferenceColumnTests(spannerDriver, getDropTestTable(spannerDriver)));
