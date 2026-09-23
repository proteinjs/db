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
   *
   * A VARIANT — one of the derived Files of this file the {@link FileVariantMaker} seam makes
   * (`preview`, `stage`): the same lifecycle for each — named here, made once (at ingest with the
   * bytes in hand, or lazily on the first request through `FileStorage.getVariant`), dropped when
   * this file's bytes change (`FileStorage.updateFileData`), deleted with this file (cascade), and
   * readable by whoever can read this file (`variantOf`).
   */
  preview?: Reference<File> | null;
  /**
   * The stage variant — a second derived `File` sized for the surface that shows the picture large
   * but not full-screen (a 1600 px longest-edge rendition where the preview is a 512 px thumbnail):
   * the same mechanism as `preview` in every respect (see there). Absent on files made before the
   * seam or of a kind the maker does not apply to (a video, an animated picture); the first request
   * derives it once. A viewer that wants every pixel keeps drawing the original.
   */
  stage?: Reference<File> | null;
  /**
   * For a variant (`preview`/`stage`) made by the seam: the File it was derived from. The
   * variant's reachability is its original's — a reader who can read the original (their own
   * scope, or a row the shared-content leg vouches for) can read the variant by its own id, even
   * when no content row names the variant (a variant derived after the content was placed). Never
   * set on a `copyForOthers` copy, whose own id is reachable by nobody but the owner. No cascade
   * in either direction: the original's own reference (`preview`/`stage`) deletes the variant.
   */
  variantOf?: Reference<File> | null;
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
    // Self-reference (the stage variant is itself a File). cascadeDelete: removing a file removes its stage variant.
    stage: new ReferenceColumn<File>('stage', FILE_TABLE_NAME, true),
    // Self-reference (a variant names its original). No cascade: the original's own reference deletes the variant.
    variantOf: new ReferenceColumn<File>('variant_of', FILE_TABLE_NAME, false),
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
