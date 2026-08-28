import { Loadable, SourceRepository } from '@proteinjs/reflection';
import type { Table } from '../Table';
import { MasterKeyProvider } from './MasterKeyProvider';

/**
 * A column-encryption configuration problem — a misdeclared column, a missing
 * `DbEncryptionConfigFactory`, an unresolvable key owner. Always a dev-time/boot-time
 * error class, never a data error.
 */
export class EncryptedColumnConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedColumnConfigError';
    // ES5 down-leveled `extends Error` loses the subclass prototype — restore it so
    // `instanceof` holds for catchers.
    Object.setPrototypeOf(this, EncryptedColumnConfigError.prototype);
  }
}

/**
 * Deployment-level configuration for column encryption (`ColumnOptions.encrypted`).
 * Registered once per app through a `DbEncryptionConfigFactory`; every encrypted read,
 * write, and translated query resolves it through `getDbEncryptionConfig`.
 */
export interface DbEncryptionConfig {
  /** The vault that wraps/unwraps per-user data keys (see `MasterKeyProvider`). */
  masterKeyProvider: MasterKeyProvider;
  /**
   * Resolve the key-owner id whose data key encrypts a row being written — the row's
   * permission-source scope owner. Return `undefined` to fall through to the framework
   * default (the row's `scope` column value). Consumer layers with richer sharing models
   * (e.g. permission-source trees) supply their scope→owner mapping here; the framework
   * stays generic.
   */
  resolveKeyOwner?: (args: { table: Table<any>; record: any }) => Promise<string | undefined>;
  /**
   * The key owners whose rows the current caller can read — the caller's own id plus the
   * (bounded) set of owners sharing rows into the caller's view. Search conditions on
   * encrypted columns fingerprint the query once per accessible owner and OR the matches,
   * so this powers shared-scope search. Required for any query that searches an encrypted
   * column; without it such queries are rejected loudly.
   */
  getAccessibleKeyOwners?: (args: { runAsSystem: boolean }) => Promise<string[]>;
  /**
   * When true, every text-holding column of every registered table MUST declare
   * `encrypted` (`false` or a config object) — registration fails loudly otherwise
   * (see `EncryptedColumns.validateDeclarations`). Ships default-OFF so existing schemas
   * keep booting; the app-wide declaration sweep turns it on.
   */
  requireEncryptedDeclarations?: boolean;
}

/** Registers the app's `DbEncryptionConfig`. Implement as a Loadable so the framework finds it. */
export interface DbEncryptionConfigFactory extends Loadable {
  getConfig(): DbEncryptionConfig;
}

let configOverride: DbEncryptionConfig | undefined;

/**
 * Set (or clear) the config without a Loadable factory — test harnesses and bootstrap
 * contexts that run outside the source-repository graph.
 */
export const setDbEncryptionConfig = (config?: DbEncryptionConfig) => {
  configOverride = config;
};

/** The registered config, or undefined when the deployment has none (a plaintext-only app). */
export const findDbEncryptionConfig = (): DbEncryptionConfig | undefined => {
  if (configOverride) {
    return configOverride;
  }

  const factory = SourceRepository.get().object<DbEncryptionConfigFactory | undefined>(
    '@proteinjs/db/DbEncryptionConfigFactory'
  );
  return factory?.getConfig();
};

/** The registered config; throws a named error when encryption is used without one. */
export const getDbEncryptionConfig = (): DbEncryptionConfig => {
  const config = findDbEncryptionConfig();
  if (!config) {
    throw new EncryptedColumnConfigError(
      `A column declares 'encrypted' but no DbEncryptionConfig is registered. Implement ` +
        `@proteinjs/db/DbEncryptionConfigFactory (or call setDbEncryptionConfig) with a ` +
        `masterKeyProvider before using encrypted columns.`
    );
  }

  return config;
};
