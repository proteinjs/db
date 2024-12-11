import { columnTypeTests, crudTests, getColTypeTestTable, getCrudTestTable } from '@proteinjs/db';
import { SpannerDriver } from '../src/SpannerDriver';
import { getDropTestTable } from './dropTestTable';
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
