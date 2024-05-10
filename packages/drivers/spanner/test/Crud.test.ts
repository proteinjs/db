import { crudTests } from '@proteinjs/db';
import { SpannerDriver } from '../src/SpannerDriver';
import { getDropTable } from './dropTable';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

describe('CRUD Tests', crudTests(spannerDriver, getDropTable(spannerDriver)));
