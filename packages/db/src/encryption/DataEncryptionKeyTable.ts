import { Table } from '../Table';
import { Record, withRecordColumns } from '../Record';
import { IntegerColumn, StringColumn } from '../Columns';

/**
 * One wrapped per-owner data key version (see `DataKeyStore`).
 *
 * - `active` — encrypts new writes (the highest active version) and fingerprints queries.
 * - `retired` — decrypt-only: envelopes referencing it still unwrap, but no new writes or
 *   query fingerprints use it. A rotation walk moves every row off a version, then retires it.
 *
 * Crypto-shred = deleting an owner's rows here: every envelope naming that owner becomes
 * permanently unreadable, including inside backups.
 */
export interface DataEncryptionKey extends Record {
  /** The key owner (a user id — the row's permission-source scope owner). */
  owner: string;
  /** Monotonic per-owner version; envelopes name (owner, version). */
  version: number;
  /** The data-key material, wrapped by the master key (`MasterKeyProvider`). */
  wrappedKey: string;
  status: 'active' | 'retired';
}

export class DataEncryptionKeyTable extends Table<DataEncryptionKey> {
  public name = 'data_encryption_key';
  public columns: Table<DataEncryptionKey>['columns'] = withRecordColumns<DataEncryptionKey>({
    owner: new StringColumn('owner', { nullable: false, encrypted: false }, 36),
    version: new IntegerColumn('version', { nullable: false }),
    // Explicitly ui-hidden: unbounded TEXT columns render on record forms now (admin round 3),
    // but this is wrapped key MATERIAL, not prose — it never renders in any UI.
    wrappedKey: new StringColumn('wrapped_key', { nullable: false, encrypted: false, ui: { hidden: true } }, 'MAX'), // already master-key-wrapped material
    status: new StringColumn('status', { nullable: false, encrypted: false }, 16),
  });
  /** (owner, version) is the identity an envelope names — the race loser on concurrent
   *  first-write key creation fails here and re-reads the winner's key. */
  public indexes: { columns: (keyof DataEncryptionKey)[]; name?: string; unique?: boolean }[] = [
    { columns: ['owner', 'version'], name: 'data_encryption_key_owner_version_unique', unique: true },
  ];
  // No auth block: default-deny for every non-system caller. Key rows are framework
  // machinery, only ever touched through system paths (DataKeyStore).
}
