import { columnTypeTests, crudTests, getColTypeTestTable, getCrudTestTable } from '@proteinjs/db';
import { SpannerDriver } from '../src/SpannerDriver';
import { getDropTable } from './dropTable';

const spannerDriverCrudTests = new SpannerDriver(
  {
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  },
  getCrudTestTable
);

describe('CRUD Tests', crudTests(spannerDriverCrudTests, getDropTable(spannerDriverCrudTests)));

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
  columnTypeTests(spannerDriverColumnTypesTests, getDropTable(spannerDriverColumnTypesTests))
);
