import { tableManagerTests } from '@proteinjs/db/test';
import { SpannerDriver } from '../src/SpannerDriver';
import { SpannerColumnTypeFactory } from '../src/SpannerColumnTypeFactory';
import { getDropTestTable } from './util/getDropTestTable';
import '../generated/test/index';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

describe(
  'Table Manager Tests',
  tableManagerTests(spannerDriver, getDropTestTable(spannerDriver), new SpannerColumnTypeFactory().getType, {
    alterColumnName: true,
    alterColumnTypes: true,
    alterNullableConstraint: true,
  })
);
