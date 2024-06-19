import {
  columnTypeTests,
  crudTests,
  getColumnTypeTestTable,
  getTestTable as getTestEmployeeTable,
} from '@proteinjs/db';
import { SpannerDriver } from '../src/SpannerDriver';
import { getDropTable } from './dropTable';

const spannerDriverCrudTests = new SpannerDriver(
  {
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  },
  getTestEmployeeTable
);

describe('CRUD Tests', crudTests(spannerDriverCrudTests, getDropTable(spannerDriverCrudTests)));

const spannerDriverColumnTypesTests = new SpannerDriver(
  {
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  },
  getColumnTypeTestTable
);

describe(
  'Column Type Tests',
  columnTypeTests(spannerDriverColumnTypesTests, getDropTable(spannerDriverColumnTypesTests))
);
