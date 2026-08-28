import { randomBytes } from 'crypto';
import { Logger } from '@proteinjs/logger';
import { getDbEncryptionConfig } from './DbEncryptionConfig';
import { DataEncryptionKey, DataEncryptionKeyTable } from './DataEncryptionKeyTable';

/**
 * Decrypt was asked for a key that does not exist — most often because the owner's keys were
 * crypto-shredded (account deletion): the ciphertext is permanently unreadable, by design.
 */
export class EncryptionKeyUnavailableError extends Error {
  constructor(owner: string, version: number) {
    super(
      `No data key exists for owner '${owner}' version ${version}. If the owner's keys were ` +
        `deleted (crypto-shred), rows encrypted under them are permanently unreadable.`
    );
    this.name = 'EncryptionKeyUnavailableError';
    Object.setPrototypeOf(this, EncryptionKeyUnavailableError.prototype);
  }
}

/** Unwrapped material of one data-key version. */
export interface DataKeyMaterial {
  owner: string;
  version: number;
  /** AES-256 key for row values (first half of the 64-byte material). */
  cipherKey: Buffer;
  /** HMAC key for search-token fingerprints (second half). */
  indexKey: Buffer;
}

interface OwnerKeyRowsCacheEntry {
  fetchedAt: number;
  rows: Pick<DataEncryptionKey, 'owner' | 'version' | 'wrappedKey' | 'status'>[];
}

interface MaterialCacheEntry {
  cachedAt: number;
  material: DataKeyMaterial;
}

interface DataKeyCaches {
  ownerRows: Map<string, OwnerKeyRowsCacheEntry>;
  material: Map<string, MaterialCacheEntry>;
}

/**
 * Per-owner data keys for column encryption: creation, unwrap-once caching, rotation,
 * retirement, and crypto-shred. Key rows live in `DataEncryptionKeyTable`, wrapped by the
 * deployment's `MasterKeyProvider`; the vault is called once per key (then cached), never
 * per row.
 *
 * All database access runs as system, OUTSIDE any ambient transaction: a key row must be
 * durable independent of the caller's transaction outcome, because unwrapped material is
 * cached in-process the moment it exists — a key created inside a transaction that later
 * rolls back would leave the cache claiming a key the database lost. An orphaned key row
 * from a rolled-back first write is harmless (a key no envelope names).
 *
 * The caches live on the global object (the per-package-install duplicate-module pattern —
 * see `Db.getDefaultDbDriver`), so every live copy of this package shares one cache.
 */
export class DataKeyStore {
  /** Unwrapped material cache TTL — bounds how long a shredded key can linger in a warm process. */
  private static readonly MATERIAL_TTL_MS = 10 * 60 * 1000;
  /** Owner key-row list TTL — bounds cross-process staleness of the active-version set. */
  private static readonly OWNER_ROWS_TTL_MS = 60 * 1000;
  private static readonly CACHES_GLOBAL_KEY = '__proteinjs_db_dataKeyCaches';
  private static readonly KEY_MATERIAL_BYTES = 64;
  private logger = new Logger({ name: this.constructor.name });
  private table = new DataEncryptionKeyTable();

  /**
   * The key that encrypts new writes for `owner`: the highest active version, created on
   * first use (each owner gets a randomly generated data key, wrapped by the master key).
   */
  async getWriteKey(owner: string): Promise<DataKeyMaterial> {
    this.requireOwner(owner);
    let rows = await this.getOwnerRows(owner);
    let active = this.highestActive(rows);
    if (!active) {
      await this.createKeyVersion(owner, 1);
      this.evictOwner(owner);
      rows = await this.getOwnerRows(owner);
      active = this.highestActive(rows);
      if (!active) {
        throw new EncryptionKeyUnavailableError(owner, 1);
      }
    }

    return await this.unwrap(active);
  }

  /** The key an envelope names — any status; decrypt must work until the key is shredded. */
  async getKeyByVersion(owner: string, version: number): Promise<DataKeyMaterial> {
    const rows = await this.getOwnerRows(owner);
    const row = rows.find((candidate) => candidate.version === version);
    if (!row) {
      // The row list may be cached from before this version existed (e.g. a fresh rotation
      // in another process) — refresh once before declaring the key gone.
      this.evictOwner(owner);
      const freshRows = await this.getOwnerRows(owner);
      const freshRow = freshRows.find((candidate) => candidate.version === version);
      if (!freshRow) {
        throw new EncryptionKeyUnavailableError(owner, version);
      }
      return await this.unwrap(freshRow);
    }

    return await this.unwrap(row);
  }

  /**
   * The index keys a query fingerprints with: every ACTIVE version of every accessible
   * owner (normally one per owner; two during a rotation window). Owners with no keys yet
   * contribute nothing — they cannot have encrypted rows.
   */
  async getQueryIndexKeys(owners: string[]): Promise<DataKeyMaterial[]> {
    const keys: DataKeyMaterial[] = [];
    for (const owner of owners) {
      const rows = await this.getOwnerRows(owner);
      for (const row of rows) {
        if (row.status === 'active') {
          keys.push(await this.unwrap(row));
        }
      }
    }

    return keys;
  }

  /**
   * Mint the next key version for `owner` (new writes use it immediately; the old version
   * stays active — still fingerprinting queries — until a rotation walk
   * (`EncryptionLifecycleWalker` mode 'rotate-keys') has rewritten every row, after which
   * the caller retires it via `retireKeyVersion`).
   * @returns the new version number
   */
  async rotateKey(owner: string): Promise<number> {
    this.requireOwner(owner);
    const rows = await this.getOwnerRows(owner);
    const highest = rows.reduce((max, row) => Math.max(max, row.version), 0);
    const newVersion = highest + 1;
    await this.createKeyVersion(owner, newVersion);
    this.evictOwner(owner);
    return newVersion;
  }

  /** Retire a version: envelopes naming it still decrypt; queries and writes stop using it. */
  async retireKeyVersion(owner: string, version: number): Promise<void> {
    const db = await this.systemDb();
    await db.update(
      this.table,
      { status: 'retired' } as Partial<DataEncryptionKey>,
      {
        owner,
        version,
      } as Partial<DataEncryptionKey>
    );
    this.evictOwner(owner);
  }

  /**
   * Crypto-shred: delete every key version of `owner` and evict the caches. Every envelope
   * naming the owner — in live rows and in every backup — becomes permanently unreadable.
   */
  async shredOwnerKeys(owner: string): Promise<number> {
    const db = await this.systemDb();
    const deleted = await db.delete(this.table, { owner } as Partial<DataEncryptionKey>);
    this.evictOwner(owner);
    const caches = this.caches();
    for (const cacheKey of Array.from(caches.material.keys())) {
      if (cacheKey.startsWith(`${owner}:`)) {
        caches.material.delete(cacheKey);
      }
    }

    this.logger.info({ message: `Crypto-shredded data keys`, obj: { owner, deleted } });
    return deleted;
  }

  private async createKeyVersion(owner: string, version: number): Promise<void> {
    const config = getDbEncryptionConfig();
    const material = randomBytes(DataKeyStore.KEY_MATERIAL_BYTES);
    const wrappedKey = await config.masterKeyProvider.wrapDataKey(material);
    const db = await this.systemDb();
    try {
      await db.insert(this.table, { owner, version, wrappedKey, status: 'active' } as Omit<
        DataEncryptionKey,
        'id' | 'created' | 'updated'
      >);
    } catch (error) {
      // Named race: two first writes for the same owner both create version 1; the unique
      // (owner, version) index rejects the loser. Re-read — if the winner's key is there,
      // use it; otherwise the failure was real.
      this.evictOwner(owner);
      const rows = await this.getOwnerRows(owner);
      if (!rows.some((row) => row.version === version)) {
        throw error;
      }
    }
  }

  private async getOwnerRows(owner: string): Promise<OwnerKeyRowsCacheEntry['rows']> {
    const caches = this.caches();
    const cached = caches.ownerRows.get(owner);
    if (cached && Date.now() - cached.fetchedAt < DataKeyStore.OWNER_ROWS_TTL_MS) {
      return cached.rows;
    }

    const db = await this.systemDb();
    const rows = await db.query(this.table, { owner } as Partial<DataEncryptionKey>);
    const entry: OwnerKeyRowsCacheEntry = {
      fetchedAt: Date.now(),
      rows: rows.map((row) => ({
        owner: row.owner,
        version: row.version,
        wrappedKey: row.wrappedKey,
        status: row.status,
      })),
    };
    caches.ownerRows.set(owner, entry);
    return entry.rows;
  }

  private async unwrap(row: Pick<DataEncryptionKey, 'owner' | 'version' | 'wrappedKey'>): Promise<DataKeyMaterial> {
    const caches = this.caches();
    const cacheKey = `${row.owner}:${row.version}`;
    const cached = caches.material.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < DataKeyStore.MATERIAL_TTL_MS) {
      return cached.material;
    }

    const config = getDbEncryptionConfig();
    const materialBytes = await config.masterKeyProvider.unwrapDataKey(row.wrappedKey);
    if (materialBytes.length !== DataKeyStore.KEY_MATERIAL_BYTES) {
      throw new Error(
        `Data key material for owner '${row.owner}' version ${row.version} has unexpected length ` +
          `${materialBytes.length} (expected ${DataKeyStore.KEY_MATERIAL_BYTES}) — wrong master key?`
      );
    }

    const material: DataKeyMaterial = {
      owner: row.owner,
      version: row.version,
      cipherKey: materialBytes.subarray(0, 32),
      indexKey: materialBytes.subarray(32, 64),
    };
    caches.material.set(cacheKey, { cachedAt: Date.now(), material });
    return material;
  }

  private highestActive(rows: OwnerKeyRowsCacheEntry['rows']) {
    return rows.filter((row) => row.status === 'active').sort((a, b) => b.version - a.version)[0] as
      | OwnerKeyRowsCacheEntry['rows'][number]
      | undefined;
  }

  private requireOwner(owner: string) {
    if (!owner || typeof owner !== 'string') {
      throw new Error(`Data key operations require a non-empty owner id; got: ${JSON.stringify(owner)}`);
    }
  }

  /**
   * A system Db pinned OUTSIDE any ambient transaction (see class doc). Imported lazily —
   * this module is reachable from the serializer layer, below `Db` in the module graph.
   */
  private async systemDb() {
    const { Db } = await import('../Db');
    const { getDefaultTransactionContextFactory } = await import('../transaction/TransactionContextFactory');
    const db = new Db(undefined, undefined, undefined, true);
    const factory = getDefaultTransactionContextFactory();
    if (!factory) {
      return db;
    }

    // Proxy every operation through an empty transaction context so key-table IO
    // auto-commits even when the caller is mid-transaction.
    return new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') {
          return value;
        }

        return (...args: any[]) => factory.runInContext({}, async () => await value.apply(target, args));
      },
    }) as InstanceType<typeof Db>;
  }

  private caches(): DataKeyCaches {
    const globalObject = globalThis as any;
    if (!globalObject[DataKeyStore.CACHES_GLOBAL_KEY]) {
      globalObject[DataKeyStore.CACHES_GLOBAL_KEY] = {
        ownerRows: new Map(),
        material: new Map(),
      } as DataKeyCaches;
    }

    return globalObject[DataKeyStore.CACHES_GLOBAL_KEY];
  }

  private evictOwner(owner: string) {
    this.caches().ownerRows.delete(owner);
  }
}
