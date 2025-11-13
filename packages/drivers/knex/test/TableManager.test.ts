import { tableManagerTests } from '@proteinjs/db/test';
import { KnexDriver } from '../src/KnexDriver';
import { KnexColumnTypeFactory } from '../src/KnexColumnTypeFactory';
import { getDropTestTable } from './util/getDropTestTable';
import '../generated/test/index';

const knexDriver = new KnexDriver({
  host: 'localhost',
  user: 'root',
  password: '',
  dbName: 'test',
});

describe(
  'Table Manager Tests',
  tableManagerTests(knexDriver, getDropTestTable(knexDriver), new KnexColumnTypeFactory().getType)
);
