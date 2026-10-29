import { Loadable, SourceRepository } from '@proteinjs/reflection';
import type { Table } from '../Table';

/** What one boot of the sync did to one source-record table. */
export type SourceRecordTableLoadSummary = {
  inserts: number;
  updates: number;
  unchanged: number;
  adopted: number;
  /**
   * Declarations whose natural key is held by a row the sync does not own (written at runtime —
   * a person's own row, say): refused for this boot, that row left exactly as it is (see
   * {@link SourceRecordOptions.naturalKey}).
   */
  refused: number;
  deletes: number;
  removedUpdates: number;
  /** Rows stamped by a newer version of their declaring package — left exactly as they are. */
  skippedNewer: number;
  /** Source-loaded rows with no owner stamp that no declaration in this build claims. */
  unowned: number;
  /**
   * PRODUCT-AUTHORED rows this boot met and left exactly as they were — rows the sync wrote
   * that the product edited on a declared column since (their `declarationStamp` no longer
   * matches), whose declaration did not move, or that no declaration names any more. The
   * precedence: the product's rows are never touched, whatever the declaration says.
   */
  kept: number;
  /**
   * TWO-SIDED divergences: rows the product edited on a declared column since the sync wrote
   * them AND whose declaration moved since as well, to something else. Counted apart from
   * `kept`, the row untouched, one warning per row naming the key and both digests (the row's
   * and the declaration's), never a failed boot — what settles it is the consumer's own
   * reconcile; the next boot after the declaration equals the row re-adopts it. A row a
   * declaration re-claims by its id under a changed natural key (a soft-removing table) counts
   * here AND in `kept`: the removed-reconcile met it under its old key and kept it, the stamp
   * leg met the declaration's claim and found the divergence — each leg reports what it met.
   */
  diverged: number;
};

export type SourceRecordLoadSummary = { [tableName: string]: SourceRecordTableLoadSummary };

/**
 * The removal guard's refusal (`SourceRecordOptions.maxRemovedFraction`): a boot that would
 * remove more than the table's named fraction of the rows this build owns on it. Thrown before
 * anything on the table is removed.
 */
export class SourceRecordRemovalRefusedError extends Error {
  constructor(
    public tableName: string,
    public removing: number,
    public owned: number,
    public maxRemovedFraction: number
  ) {
    super(
      `(${tableName}) Refusing to remove ${removing} of the ${owned} rows this build owns — more than the table's ` +
        `maxRemovedFraction ${maxRemovedFraction}. A wrong or empty declaration? Nothing on the table was changed.`
    );
    this.name = 'SourceRecordRemovalRefusedError';
    Object.setPrototypeOf(this, SourceRecordRemovalRefusedError.prototype);
  }
}

/**
 * The source-record sync a boot runs — the seam `Db.init` (and the pre-schema-sync migration
 * phase) reach it through. Its one implementation, `SourceRecordSyncRunner`, is server-only code:
 * it reads package.json files off the booting process to version-stamp every row, so it lives
 * behind the `@proteinjs/db/source` subpath and this package's browser index never carries it
 * (test/BrowserIndexNoNodeBuiltins.test.ts holds that line). A server imports
 * `@proteinjs/db/source` once at boot, which registers the runner here through reflection; the
 * browser index declares only this interface.
 */
export interface SourceRecordSync extends Loadable {
  /** One boot of the sync, for every source-record table in the build — or for `onlyTable`. */
  load(onlyTable?: Table<any>): Promise<SourceRecordLoadSummary>;
}

/**
 * The registered sync — or a loud refusal naming the subpath that registers it. A boot never
 * silently skips its source records: a server that has not imported `@proteinjs/db/source` fails
 * here, at `Db.init`, with the fix in the message.
 */
export const getSourceRecordSync = (): SourceRecordSync => {
  const sync = SourceRepository.get().object<SourceRecordSync>('@proteinjs/db/SourceRecordSync');
  if (!sync) {
    throw new Error(
      `Unable to find a @proteinjs/db/SourceRecordSync implementation. The source-record sync is server-only code behind the '@proteinjs/db/source' subpath: import '@proteinjs/db/source' once in the server's boot (it registers SourceRecordSyncRunner), and the boot's source records load.`
    );
  }

  return sync;
};
