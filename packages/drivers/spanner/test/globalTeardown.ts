import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';

/**
 * Jest's once-per-run teardown (jest.config.js `globalTeardown`): releases the admin client
 * globalSetup opened, so the run's process can drain.
 */
export default function releaseTestEmulator(): void {
  SpannerEmulatorProvisioner.release();
}
