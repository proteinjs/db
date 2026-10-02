import { crudTests } from '@proteinjs/db/test';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import '../generated/test/index';

const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};

const spannerDriver = new SpannerDriver(spannerConfig);

// The reusable suite assumes its instance and database exist; on an emulator this suite
// provisions them itself, so it runs alone on a fresh emulator as its siblings do.
beforeAll(async () => {
  await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
}, 60000);

afterAll(() => {
  SpannerEmulatorProvisioner.release();
});

describe('CRUD Tests', crudTests(spannerDriver, new TransactionContext(), getDropTestTable(spannerDriver)));
