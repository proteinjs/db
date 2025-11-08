import { DbDriver, DefaultDbDriverFactory } from '@proteinjs/db';
import { SpannerDriver } from '../../src/SpannerDriver';

const spannerDriver = new SpannerDriver({
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
});

export class TestDbDriverFactory implements DefaultDbDriverFactory {
  getDbDriver(): DbDriver {
    return spannerDriver;
  }
}
