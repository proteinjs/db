import { crudTests, getTable } from '@proteinjs/db';
import { SpannerDriver } from '../src/SpannerDriver';
import { getDropTable } from './dropTable';
import { Logger } from '@proteinjs/util';

const spannerDriver = new SpannerDriver(
  {
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  },
  getTable
);

describe('CRUD Tests', crudTests(spannerDriver, getDropTable(spannerDriver)));
