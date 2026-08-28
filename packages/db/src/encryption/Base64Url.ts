/**
 * Base64url (RFC 4648 §5) over Buffers, hand-rolled because the package's @types/node
 * predates the 'base64url' BufferEncoding. URL/filename-safe alphabet, no padding — safe
 * inside the colon-delimited ciphertext envelope and as index-column values.
 */
export class Base64Url {
  static encode(bytes: Buffer): string {
    return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  static decode(encoded: string): Buffer {
    return Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
}
