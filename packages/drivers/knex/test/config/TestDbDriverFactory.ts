import { DbDriver, DefaultDbDriverFactory } from '@proteinjs/db';
import { KnexDriver } from '../../src/KnexDriver';

const knexDriver = new KnexDriver({
  host: 'localhost',
  user: 'root',
  password: '',
  dbName: 'test',
});

export class TestDbDriverFactory implements DefaultDbDriverFactory {
  getDbDriver(): DbDriver {
    return knexDriver;
  }
}
