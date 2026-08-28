import { KeyManagementServiceClient } from '@google-cloud/kms';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { GcpKmsMasterKeyProvider } from '../src/GcpKmsMasterKeyProvider';

const KEY_NAME = 'projects/p/locations/l/keyRings/r/cryptoKeys/k';

/**
 * An in-memory stand-in for the KMS service (the adapter's only unmockable dependency is
 * the network): encrypts/decrypts with a local AES key, and records the key resource names
 * it was called with — so the adapter's contract (right key name, bytes-in/bytes-out,
 * base64 at the storage boundary) is pinned without live GCP. The live path is exercised
 * manually against a real key ring before production use (no cloud creds in CI).
 */
class FakeKmsClient {
  public encryptCalls: string[] = [];
  public decryptCalls: string[] = [];
  private key = randomBytes(32);

  async encrypt(request: { name: string; plaintext: Buffer }): Promise<[{ ciphertext: Uint8Array }]> {
    this.encryptCalls.push(request.name);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(request.plaintext), cipher.final()]);
    return [{ ciphertext: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]) }];
  }

  async decrypt(request: { name: string; ciphertext: Buffer }): Promise<[{ plaintext: Uint8Array }]> {
    this.decryptCalls.push(request.name);
    const bytes = request.ciphertext;
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return [
      {
        plaintext: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]),
      },
    ];
  }
}

describe('GcpKmsMasterKeyProvider', () => {
  test('wrap/unwrap round-trips data-key material through the configured KMS key', async () => {
    const fakeClient = new FakeKmsClient();
    const provider = new GcpKmsMasterKeyProvider(
      { keyName: KEY_NAME },
      fakeClient as unknown as KeyManagementServiceClient
    );

    const material = randomBytes(64);
    const wrapped = await provider.wrapDataKey(material);
    expect(typeof wrapped).toBe('string');
    expect(wrapped).not.toContain(material.toString('base64'));

    const unwrapped = await provider.unwrapDataKey(wrapped);
    expect(unwrapped.equals(material)).toBe(true);

    expect(fakeClient.encryptCalls).toEqual([KEY_NAME]);
    expect(fakeClient.decryptCalls).toEqual([KEY_NAME]);
    expect(provider.getMasterKeyId()).toBe(KEY_NAME);
  });

  test('an empty KMS response fails loudly, never returns empty key material', async () => {
    const emptyClient = {
      encrypt: async () => [{}],
      decrypt: async () => [{}],
    };
    const provider = new GcpKmsMasterKeyProvider(
      { keyName: KEY_NAME },
      emptyClient as unknown as KeyManagementServiceClient
    );

    await expect(provider.wrapDataKey(randomBytes(64))).rejects.toThrow(/no ciphertext/);
    await expect(provider.unwrapDataKey('AAAA')).rejects.toThrow(/no plaintext/);
  });
});
