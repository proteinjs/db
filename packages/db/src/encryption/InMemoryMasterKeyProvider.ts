import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { Base64Url } from './Base64Url';
import { MasterKeyProvider } from './MasterKeyProvider';

/**
 * A `MasterKeyProvider` holding the master key in process memory. For tests and local
 * development only — a production deployment keeps its master key in a vault
 * (`GcpKmsMasterKeyProvider`), where the key material never enters the app process.
 *
 * Wraps with AES-256-GCM. Constructing with the same `secret` yields a provider that can
 * unwrap keys wrapped by a previous instance (test fixtures across processes); constructing
 * with no secret generates a random master key for the life of the process.
 */
export class InMemoryMasterKeyProvider implements MasterKeyProvider {
  private masterKey: Buffer;

  constructor(secret?: string) {
    this.masterKey = secret ? createHash('sha256').update(secret).digest() : randomBytes(32);
  }

  async wrapDataKey(plaintextKeyMaterial: Buffer): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintextKeyMaterial), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Base64Url.encode(Buffer.concat([iv, authTag, ciphertext]));
  }

  async unwrapDataKey(wrappedKeyMaterial: string): Promise<Buffer> {
    const bytes = Base64Url.decode(wrappedKeyMaterial);
    const iv = bytes.subarray(0, 12);
    const authTag = bytes.subarray(12, 28);
    const ciphertext = bytes.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  getMasterKeyId(): string {
    return 'in-memory';
  }
}
