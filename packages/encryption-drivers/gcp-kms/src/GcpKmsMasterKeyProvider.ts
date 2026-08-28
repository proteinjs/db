import { KeyManagementServiceClient } from '@google-cloud/kms';
import { MasterKeyProvider } from '@proteinjs/db';

export interface GcpKmsMasterKeyConfig {
  /**
   * The Cloud KMS crypto key's full resource name:
   * `projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>`
   */
  keyName: string;
}

/**
 * The production `MasterKeyProvider` for @proteinjs/db column encryption: the master key
 * lives in Cloud KMS and never leaves the vault — KMS performs the wrap (encrypt) and
 * unwrap (decrypt) of per-owner data keys for callers holding permission on the key.
 *
 * Operational shape (see the framework's `DataKeyStore`): the vault is called once per data
 * key and cached in-process, never per row — a warm request makes zero KMS calls. Grant
 * `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the key to the identity the production
 * server runs as (its service account) and to nothing else; granting anyone else is a
 * configuration change Google records in admin logs that cannot be turned off.
 *
 * Key rotation note: KMS crypto keys can rotate their PRIMARY version automatically;
 * `decrypt` transparently uses the version that encrypted each wrapped key, so stored
 * wrapped data keys keep unwrapping across KMS rotations with no application involvement
 * (per-owner DATA-key rotation is the framework's own `rotate-keys` walk, a separate
 * concern).
 */
export class GcpKmsMasterKeyProvider implements MasterKeyProvider {
  private config: GcpKmsMasterKeyConfig;
  private client: KeyManagementServiceClient;

  constructor(config: GcpKmsMasterKeyConfig, client?: KeyManagementServiceClient) {
    this.config = config;
    this.client = client ?? new KeyManagementServiceClient();
  }

  async wrapDataKey(plaintextKeyMaterial: Buffer): Promise<string> {
    const [result] = await this.client.encrypt({
      name: this.config.keyName,
      plaintext: plaintextKeyMaterial,
    });
    if (!result.ciphertext) {
      throw new Error(`Cloud KMS encrypt returned no ciphertext for key ${this.config.keyName}`);
    }

    return Buffer.from(result.ciphertext as Uint8Array).toString('base64');
  }

  async unwrapDataKey(wrappedKeyMaterial: string): Promise<Buffer> {
    const [result] = await this.client.decrypt({
      name: this.config.keyName,
      ciphertext: Buffer.from(wrappedKeyMaterial, 'base64'),
    });
    if (!result.plaintext) {
      throw new Error(`Cloud KMS decrypt returned no plaintext for key ${this.config.keyName}`);
    }

    return Buffer.from(result.plaintext as Uint8Array);
  }

  getMasterKeyId(): string {
    return this.config.keyName;
  }
}
