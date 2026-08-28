/**
 * The master-key seam of column encryption (see `EncryptedColumnConfig`).
 *
 * One master key exists per deployment, held in a key vault (Cloud KMS in production, an
 * in-memory key in tests). The master key never encrypts row data directly — it wraps
 * (encrypts) each user's randomly generated data key, and those per-user data keys encrypt
 * the rows in that user's scope. The vault is therefore called once per data key
 * (unwrap-once-per-key caching lives in `DataKeyStore`), never per row.
 *
 * Implementations:
 * - `InMemoryMasterKeyProvider` (this package) — tests and local development.
 * - `GcpKmsMasterKeyProvider` (`@proteinjs/db-encryption-driver-gcp-kms`) — Cloud KMS.
 */
export interface MasterKeyProvider {
  /**
   * Encrypt (wrap) raw data-key material under the master key.
   * @returns an opaque string safe to store in the data-key table
   */
  wrapDataKey(plaintextKeyMaterial: Buffer): Promise<string>;

  /** Decrypt (unwrap) previously wrapped data-key material. */
  unwrapDataKey(wrappedKeyMaterial: string): Promise<Buffer>;

  /** Stable identifier of the master key (a KMS resource name, or 'in-memory') — observability only. */
  getMasterKeyId(): string;
}
