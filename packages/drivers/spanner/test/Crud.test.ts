import {
  columnTypeTests,
  crudTests,
  dynamicReferenceColumnTests,
  getColTypeTestTable,
  getCrudTestTable,
  getDynamicReferenceColumnTestTable,
} from '@proteinjs/db';
import { SpannerDriver } from '../src/SpannerDriver';
import { getDropTestTable } from './util/dropTestTable';
import { TransactionContext } from '@proteinjs/db-transaction-context';

const spannerDriverCrudTests = new SpannerDriver(
  {
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  },
  getCrudTestTable
);

describe(
  'CRUD Tests',
  crudTests(spannerDriverCrudTests, new TransactionContext(), getDropTestTable(spannerDriverCrudTests))
);

const spannerDriverColumnTypesTests = new SpannerDriver(
  {
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  },
  getColTypeTestTable
);

describe(
  'Column Type Tests',
  columnTypeTests(
    spannerDriverColumnTypesTests,
    new TransactionContext(),
    getDropTestTable(spannerDriverColumnTypesTests)
  )
);

const spannerDriverDynamicRefColTests = new SpannerDriver(
  {
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  },
  getDynamicReferenceColumnTestTable
);

describe(
  'DynamicReferenceColumn Tests',
  dynamicReferenceColumnTests(spannerDriverDynamicRefColTests, getDropTestTable(spannerDriverDynamicRefColTests))
);
