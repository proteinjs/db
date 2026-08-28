/**
 * A query asked an encrypted column for a shape outside the compatibility contract
 * (`EncryptionQueryTranslator`). Thrown at query-build time, before any statement runs —
 * the message names the limitation and the sanctioned paths, so the limitation cannot be
 * hit silently.
 */
export class EncryptedColumnQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedColumnQueryError';
    // ES5 down-leveled `extends Error` loses the subclass prototype — restore it so
    // `instanceof` holds for catchers.
    Object.setPrototypeOf(this, EncryptedColumnQueryError.prototype);
  }
}
