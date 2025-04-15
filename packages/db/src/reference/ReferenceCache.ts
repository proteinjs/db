/**
 * A way to cache referenced objects. Cached objects are consumed within `Reference`.
 *
 * A common way to use this would be to cache shared reference data on the client. Without
 * this, reference data would be unique per `Reference` object, since `Reference.get` fetches
 * a new instance of an object over the wire.
 */
export class ReferenceCache {
  private cache: { [table: string]: { [id: string]: any } } = {};

  /**
   * Returns the singleton instance of ReferenceCache
   *
   * @returns The global ReferenceCache instance
   */
  static get(): ReferenceCache {
    if (!ReferenceCache.getGlobal().__proteinjs_db_ReferenceCache) {
      ReferenceCache.getGlobal().__proteinjs_db_ReferenceCache = new ReferenceCache();
    }

    return ReferenceCache.getGlobal().__proteinjs_db_ReferenceCache;
  }

  /**
   * Returns the global object based on environment
   *
   * @returns The global object (window in browser, globalThis elsewhere)
   */
  private static getGlobal(): any {
    if (typeof window !== 'undefined') {
      return window;
    }

    return globalThis;
  }

  /**
   * Gets a record from the cache for a specific table by ID
   *
   * @param table Name of the table containing the record
   * @param id ID of the record to retrieve
   * @returns The cached record or undefined if not found
   */
  get<T>(table: string, id: string): T | undefined {
    return this.cache[table]?.[id];
  }

  /**
   * Sets a single record in the cache
   *
   * @param table Name of the table to add the record to
   * @param id ID of the record
   * @param record The record data to store
   */
  set(table: string, id: string, record: any): void {
    this.ensureTableExists(table);
    this.cache[table][id] = record;
  }

  /**
   * Ensures a table exists in the cache
   *
   * @param table Name of the table to initialize if needed
   */
  private ensureTableExists(table: string): void {
    if (!this.cache[table]) {
      this.cache[table] = {};
    }
  }

  /**
   * Clears all cached records for a specific table
   *
   * @param table Name of the table to clear from cache
   */
  clearTable(table: string): void {
    if (this.cache[table]) {
      delete this.cache[table];
    }
  }

  /**
   * Sets multiple records for a specific table at once
   *
   * @param table Name of the table to add records to
   * @param records Either an array of records or an object mapping record IDs to their values
   */
  setMultiple<T extends { [key: string]: any } & { id: string }>(
    table: string,
    records: T[] | { [id: string]: T }
  ): void {
    this.ensureTableExists(table);

    if (Array.isArray(records)) {
      // Handle array input
      for (const record of records) {
        this.cache[table][record.id] = record;
      }
    } else {
      // Handle map/object input
      for (const [id, record] of Object.entries(records)) {
        this.cache[table][id] = record;
      }
    }
  }

  /**
   * Reloads a table by clearing it and then setting the provided records
   *
   * @param table Name of the table to reload
   * @param records Either an array of records or an object mapping record IDs to their values
   */
  reloadTable<T extends { [key: string]: any } & { id: string }>(
    table: string,
    records: T[] | { [id: string]: T }
  ): void {
    this.clearTable(table);
    this.setMultiple(table, records);
  }
}
