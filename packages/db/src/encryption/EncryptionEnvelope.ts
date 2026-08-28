import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { Base64Url } from './Base64Url';
import type { DataKeyMaterial } from './DataKeyStore';

/**
 * The self-describing ciphertext envelope an encrypted column stores:
 *
 *   `pjenc:1:<ownerId>:<keyVersion>:<base64url(iv || authTag || ciphertext)>`
 *
 * Decrypt resolves the key FROM the envelope (owner + version), never from who is asking —
 * a shared row decrypts for whoever the permission layer admits, and key rotation is a
 * background rewrite. Cipher: AES-256-GCM (12-byte IV, 16-byte tag), the data key's cipher
 * half (`DataKeyMaterial.cipherKey`).
 */
export class EncryptionEnvelope {
  static readonly PREFIX = 'pjenc:1:';
  private static readonly ENVELOPE_PATTERN = /^pjenc:1:([^:]+):(\d+):([A-Za-z0-9_-]+)$/;

  encrypt(plaintext: string, key: DataKeyMaterial): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key.cipherKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const payload = Base64Url.encode(Buffer.concat([iv, authTag, ciphertext]));
    return `${EncryptionEnvelope.PREFIX}${key.owner}:${key.version}:${payload}`;
  }

  decrypt(envelope: string, key: DataKeyMaterial): string {
    const parsed = this.parse(envelope);
    if (!parsed) {
      throw new Error(`Value is not a ciphertext envelope`);
    }

    const bytes = Base64Url.decode(parsed.payload);
    const iv = bytes.subarray(0, 12);
    const authTag = bytes.subarray(12, 28);
    const ciphertext = bytes.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key.cipherKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  /** Owner + version + payload when `value` is an envelope, else undefined. */
  parse(value: unknown): { owner: string; version: number; payload: string } | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const match = EncryptionEnvelope.ENVELOPE_PATTERN.exec(value);
    if (!match) {
      return undefined;
    }

    return { owner: match[1], version: parseInt(match[2], 10), payload: match[3] };
  }

  isEnvelope(value: unknown): boolean {
    return this.parse(value) !== undefined;
  }
}
