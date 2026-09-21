import { tableManagerTests } from '@proteinjs/db/test';
import { KnexDriver } from '@proteinjs/db-driver-knex';
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
  tableManagerTests(knexDriver, getDropTestTable(knexDriver), new KnexColumnTypeFactory().getType, {
    // This driver's schema builder creates ascending keys only: it refuses a descending declaration
    // by name, and the reusable suite proves the refusal in place of the descending-index tests.
    descendingIndexes: true,
  })
);
