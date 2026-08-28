import type { Table } from '../Table';

/**
 * Registry of framework-DERIVED tables (search-token tables beside encrypted-searchable
 * columns — see `EncryptedColumns`). Derived tables are synthesized from column config, not
 * declared in source, so the reflection-backed table registry never sees them; `tableByName`
 * consults this registry after the source registry misses.
 *
 * Lives on the global object so every live copy of this package (per-package installs)
 * shares one registry — same pattern as `Db.getDefaultDbDriver`.
 *
 * Deliberately import-cycle-free: `Table` is a type-only import (erased at runtime), so
 * `Table.ts` can import this module without closing a load-order loop.
 */
export class EncryptionDerivedTableRegistry {
  private static readonly GLOBAL_KEY = '__proteinjs_db_encryptionDerivedTables';

  static get(tableName: string): Table<any> | undefined {
    return EncryptionDerivedTableRegistry.tables().get(tableName);
  }

  static register(table: Table<any>): void {
    EncryptionDerivedTableRegistry.tables().set(table.name, table);
  }

  private static tables(): Map<string, Table<any>> {
    const globalObject = globalThis as any;
    if (!globalObject[EncryptionDerivedTableRegistry.GLOBAL_KEY]) {
      globalObject[EncryptionDerivedTableRegistry.GLOBAL_KEY] = new Map<string, Table<any>>();
    }

    return globalObject[EncryptionDerivedTableRegistry.GLOBAL_KEY];
  }
}
