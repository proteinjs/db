import './setup';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';

/**
 * Jest's once-per-run hook (jest.config.js `globalSetup`): the emulator instance and database every
 * suite in this package names exist before the first suite runs, so any suite — or any subset of
 * them — runs alone on a bare emulator. The host is the one the suites run under (test/setup.ts's
 * default, or `SPANNER_EMULATOR_HOST`); off the emulator the provisioner is a no-op. The admin
 * client it opens stays open until globalTeardown releases it: closing right after the create
 * operations races their trailing callbacks (see the provisioner).
 */
export default async function provisionTestEmulator(): Promise<void> {
  await SpannerEmulatorProvisioner.ensureProvisioned({
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  });
}
