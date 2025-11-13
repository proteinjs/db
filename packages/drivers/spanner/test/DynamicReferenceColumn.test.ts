import { dynamicReferenceColumnTests } from '@proteinjs/db/test';
import { SpannerDriver } from '../src/SpannerDriver';
import { getDropTestTable } from './util/getDropTestTable';
import '../generated/test/index';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

describe('DynamicReferenceColumn Tests', dynamicReferenceColumnTests(spannerDriver, getDropTestTable(spannerDriver)));
