import { Table, StringColumn, IntegerColumn, ReferenceColumn, Reference, DateColumn } from '@proteinjs/db';
import { ScopedRecord, withScopedRecordColumns, createScopedIndex } from '@proteinjs/user';

const FILE_TABLE_NAME = 'file';

export interface File extends ScopedRecord {
  name: string;
  type: string;
  size: number;
  /**
   * Optional preview — another `File` (stored the same way, in GCS) used as a preview/thumbnail of
   * this file's content, e.g. a recording GIF's preview frame. A reference, not an inline blob, so
   * the bytes stay out of the DB row (consistent with the storage model); deleted with this file.
   */
  preview?: Reference<File>;
  /**
   * The copy of this file served to anyone who is not its owner — another `File` (the same
   * store, the owner's scope), made ONCE by the registered {@link FileCopyForOthers} the first
   * time a non-owner reads the bytes, named here so every later read serves it without remaking
   * it. `null`/absent means no copy has been made yet: the next non-owner read makes one when the
   * maker applies to this file, and serves the original when it does not. Dropped when the
   * original's bytes change (`FileStorage.updateFileData`) and deleted with this file (cascade).
   * The owner is never served it — their own scoped read serves the original.
   */
  copyForOthers?: Reference<File> | null;
  /**
   * Media metadata — generic file facts (an image/video's pixel dimensions, a video/audio
   * duration) every consumer needs to render without loading bytes, e.g. reserving a media box's
   * aspect ratio before any bytes arrive. Set at ingest for media files; absent for everything
   * else.
   */
  width?: number;
  height?: number;
  durationMs?: number;
  /**
   * Web provenance — set when the bytes were fetched from the internet on the user's behalf
   * (a saved web image): the direct URL the bytes came from, the page they were found on, and
   * when they were retrieved. A provenance record (evidence the source was live and valid at
   * save time — pages rot; the copy + stamp is what still proves it later) that every consumer
   * needs to render source attribution without a join. Absent for locally-produced files.
   */
  sourceUrl?: string;
  sourcePageUrl?: string;
  retrievedAt?: Date;
  /**
   * Rights record — set when a web-saved copy came from a source that states a licence per
   * item (a Creative Commons / public-domain work): the licence's name ("CC BY-SA 4.0"), its
   * deed URL, and the ready credit sentence the source supplies. Every consumer that renders the
   * copy can show the licence beside the source without a join; absent when the source stated
   * none (a plain provenance copy) and for locally-produced files. Accuracy is the source's
   * claim, recorded — never vouched for here.
   */
  license?: string;
  licenseUrl?: string;
  attribution?: string;
  /**
   * SHA-256 of the stored bytes (hex), stamped at media ingest. Enables content dedup — the
   * same web image saved twice (or cited from two pages) reuses one File row — and doubles as
   * an integrity fact. Absent for files written before the column existed.
   */
  contentHash?: string;
}

export class FileTable extends Table<File> {
  public name = FILE_TABLE_NAME;
  public auth: Table<File>['auth'] = {
    db: {
      all: 'authenticated',
    },
    service: {
      all: 'authenticated',
    },
  };
  public columns = withScopedRecordColumns<File>({
    name: new StringColumn('name'),
    type: new StringColumn('type'),
    size: new IntegerColumn('size'),
    // Self-reference (the preview is itself a File). cascadeDelete: removing a file removes its preview.
    preview: new ReferenceColumn<File>('preview', FILE_TABLE_NAME, true),
    // Self-reference (the copy is itself a File). cascadeDelete: removing a file removes the copy others were served.
    copyForOthers: new ReferenceColumn<File>('copy_for_others', FILE_TABLE_NAME, true),
    width: new IntegerColumn('width'),
    height: new IntegerColumn('height'),
    durationMs: new IntegerColumn('duration_ms'),
    // Web provenance (see the interface docs). URLs can be long — MAX, like any URL storage.
    sourceUrl: new StringColumn('source_url', {}, 'MAX'),
    sourcePageUrl: new StringColumn('source_page_url', {}, 'MAX'),
    retrievedAt: new DateColumn('retrieved_at'),
    // Rights record (see the interface docs): a licence name is short; the deed URL and the
    // credit sentence are free text — MAX, like the provenance URLs.
    license: new StringColumn('license', {}, 64),
    licenseUrl: new StringColumn('license_url', {}, 'MAX'),
    attribution: new StringColumn('attribution', {}, 'MAX'),
    contentHash: new StringColumn('content_hash', {}, 64),
  });
  // Dedup lookup path: find the caller's existing copy of these bytes (content_hash is only
  // ever queried per-user — createScopedIndex prefixes the scope column).
  public indexes = [createScopedIndex<File>({ columns: ['contentHash'], name: 'file_content_hash_idx' })];
  // No cascadeDeleteReferences for FileData: byte cleanup (FileData rows included) is owned by
  // FileStorageDriver.deleteFile, invoked for every file-row delete by FileStorageTableWatcher.
}
