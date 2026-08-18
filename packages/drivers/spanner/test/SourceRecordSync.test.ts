import { sourceRecordSyncTests } from '@proteinjs/db/test';
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

beforeAll(async () => {
  await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
}, 60000);

afterAll(() => {
  SpannerEmulatorProvisioner.release();
});

describe(
  'Source record sync (mixed tables, natural-key adoption, onSourceRemoved, unique preflight)',
  sourceRecordSyncTests(spannerDriver, new TransactionContext(), getDropTestTable(spannerDriver))
);
