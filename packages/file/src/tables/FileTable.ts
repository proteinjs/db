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
    name: new StringColumn('name', { encrypted: {} }), // user-supplied filenames are titles — content (TRUST_AND_COMPLIANCE §1)
    type: new StringColumn('type', { encrypted: false }), // MIME vocabulary
    size: new IntegerColumn('size'),
    // Self-reference (the preview is itself a File). cascadeDelete: removing a file removes its preview.
    preview: new ReferenceColumn<File>('preview', FILE_TABLE_NAME, true),
    width: new IntegerColumn('width'),
    height: new IntegerColumn('height'),
    durationMs: new IntegerColumn('duration_ms'),
    // Web provenance (see the interface docs). URLs can be long — MAX, like any URL storage.
    sourceUrl: new StringColumn('source_url', { encrypted: false }, 'MAX'), // encryption wave-B residue: capture-source URLs reveal reading habits; unaudited consumers keep this plaintext this wave
    sourcePageUrl: new StringColumn('source_page_url', { encrypted: false }, 'MAX'), // encryption wave-B residue: same as sourceUrl
    retrievedAt: new DateColumn('retrieved_at'),
    contentHash: new StringColumn('content_hash', { encrypted: false }, 64), // named plaintext exemption: opaque dedupe fingerprint, indexed (TRUST_AND_COMPLIANCE §1)
  });
  // Dedup lookup path: find the caller's existing copy of these bytes (content_hash is only
  // ever queried per-user — createScopedIndex prefixes the scope column).
  public indexes = [createScopedIndex<File>({ columns: ['contentHash'], name: 'file_content_hash_idx' })];
  // No cascadeDeleteReferences for FileData: byte cleanup (FileData rows included) is owned by
  // FileStorageDriver.deleteFile, invoked for every file-row delete by FileStorageTableWatcher.
}
