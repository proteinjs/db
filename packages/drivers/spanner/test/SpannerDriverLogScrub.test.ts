/**
 * TRUST_AND_COMPLIANCE Firmed-up §2.0 at the driver seam: bound statement params carry
 * encrypted-column envelopes (`pjenc:1:...`) below the statement builder, and the driver's
 * query/DML logging (including the always-on error paths) must log them as size markers,
 * never as ciphertext. Non-envelope params pass through — after the app-wide declaration
 * sweep those are metadata by construction, and sizes stay loggable on purpose.
 */
import { EncryptionEnvelope } from '@proteinjs/db';
import { SpannerDriver } from '../src/SpannerDriver';

type DriverInternals = { paramsForLog(params: { [key: string]: any } | undefined): { [key: string]: any } | undefined };

const driverInternals = () =>
  new SpannerDriver({
    projectId: 'scrub-test',
    instanceName: 'scrub-test',
    databaseName: 'scrub_test',
  }) as unknown as DriverInternals;

describe('SpannerDriver param log scrub (§2.0)', () => {
  // 11-byte plaintext -> 39 ciphertext bytes (IV 12 + tag 16 + 11) -> 52 base64url chars.
  // The marker carries PLAINTEXT BYTES, computed key-free (EncryptionEnvelope.logMarker).
  const envelope = `${EncryptionEnvelope.PREFIX}owner-1:1:${'A'.repeat(52)}`;

  test('envelope param values log as [encrypted len=N] (N = plaintext bytes); metadata passes through', () => {
    const safe = driverInternals().paramsForLog({
      p1: envelope,
      p2: 'metadata-value',
      p3: 42,
      p4: null,
    })!;
    expect(safe.p1).toBe('[encrypted len=11]');
    expect(safe.p2).toBe('metadata-value');
    expect(safe.p3).toBe(42);
    expect(safe.p4).toBeNull();
    expect(JSON.stringify(safe)).not.toContain(EncryptionEnvelope.PREFIX);
  });

  test('undefined params pass through (no-param statements)', () => {
    expect(driverInternals().paramsForLog(undefined)).toBeUndefined();
  });
});
