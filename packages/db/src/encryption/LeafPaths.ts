import type { Table } from '../Table';
import { EncryptedColumnConfigError } from './DbEncryptionConfig';
import { EncryptedColumns } from './EncryptedColumns';
import { isLeafPolicySource } from './LeafPolicy';

/**
 * The raw-SQL gate for leaf-encrypted JSON columns. The ORM never reads a content leaf's value
 * (its query layer has no JSON-path condition), but raw DML does — `JSON_VALUE` / `JSON_SET` /
 * `JSON_REMOVE` in migrations. A raw `JSON_SET` on a CONTENT path would write plaintext into a
 * content slot; a `JSON_VALUE` on one reads ciphertext. Every raw-SQL site names each path it
 * touches through {@link assertMetadata} before building its statement, and the site's test
 * pins the assertion — a content path throws here, loudly, before any SQL runs.
 */
export class LeafPaths {
  /**
   * Throw unless `path` is metadata under every policy `table.prop` can carry. A plaintext
   * column passes (nothing to assert); a whole-value encrypted column refuses every path (its
   * ciphertext has no readable paths at all).
   */
  static assertMetadata(table: Table<any>, prop: string, path: string): void {
    const encryptedColumns = new EncryptedColumns();
    encryptedColumns.ensureSchema(table);
    const config = encryptedColumns.configFor(table, prop);
    if (!config) {
      return;
    }
    if (!config.leaves) {
      throw new EncryptedColumnConfigError(
        `(${table.name}.${prop}) is encrypted whole-value; raw SQL cannot read or set '${path}' inside its ciphertext.`
      );
    }
    const alwaysMetadata = isLeafPolicySource(config.leaves)
      ? !!config.leaves.isAlwaysMetadata?.(path)
      : config.leaves.classify(path, '') === 'metadata';
    if (!alwaysMetadata) {
      throw new EncryptedColumnConfigError(
        `(${table.name}.${prop}) '${path}' is not declared metadata under every leaf policy of this column — ` +
          `raw SQL may only read or set metadata paths (a content path holds ciphertext).`
      );
    }
  }

  /** Assert several paths at once (the shape a migration with a handful of JSON paths uses). */
  static assertAllMetadata(table: Table<any>, prop: string, paths: string[]): void {
    for (const path of paths) {
      LeafPaths.assertMetadata(table, prop, path);
    }
  }
}
