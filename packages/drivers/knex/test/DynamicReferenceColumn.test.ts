import { dynamicReferenceColumnTests } from '@proteinjs/db/test';
import { KnexDriver } from '../src/KnexDriver';
import { getDropTestTable } from './util/getDropTestTable';
import '../generated/test/index';

const knexDriver = new KnexDriver({
  host: 'localhost',
  user: 'root',
  password: '',
  dbName: 'test',
});

describe('DynamicReferenceColumn Tests', dynamicReferenceColumnTests(knexDriver, getDropTestTable(knexDriver)));
