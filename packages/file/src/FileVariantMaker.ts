import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { File } from './tables/FileTable';

/**
 * The kinds of derived File a file can carry — each a seat on the row (`File.preview`,
 * `File.stage`) with one lifecycle: made once, named on the row, dropped when the original's
 * bytes change, deleted with the original, readable by whoever can read the original.
 */
export type FileVariantKind = 'preview' | 'stage';

export const FILE_VARIANT_KINDS: readonly FileVariantKind[] = ['preview', 'stage'];

/** What the maker hands back for a variant: the bytes, their type, and the facts a consumer renders from without loading them. */
export interface FileVariant {
  bytes: Buffer;
  type: string;
  width?: number;
  height?: number;
}

/**
 * How a derived File of a File is made — ONE owner for "a variant of this file's bytes".
 *
 * The library owns the seat on the row, the lifecycle and the access rule for every variant
 * (`FileStorage.deriveVariants` at ingest, `FileStorage.getVariant` on the read path); the one
 * package that knows the file's format registers how the variant's bytes are made — a picture's
 * 512 px thumbnail (`preview`) and its 1600 px rendition for the stage (`stage`) are two answers
 * of the same maker, never two mechanisms. Dependency direction is the
 * {@link FileReachabilityResolver} / {@link FileCopyForOthers} pattern: the interface here, the
 * implementation above, discovered through the SourceRepository. With no maker registered no
 * variant is ever made and every consumer draws the original.
 */
export interface FileVariantMaker extends Loadable {
  /**
   * Whether a variant of this kind is made of this file at all — decided from the row alone,
   * never from its bytes (a document, a clip, a picture already small enough cost no read). True
   * means {@link make} is called once with the original's bytes and its answer is stored.
   */
  appliesTo(file: File, kind: FileVariantKind): boolean;
  /** The variant, made from the original's bytes. Throws when it cannot be made — nothing is stored, the consumer draws the original. */
  make(file: File, bytes: Buffer, kind: FileVariantKind): Promise<FileVariant>;
}

export const getFileVariantMaker = (): FileVariantMaker | undefined =>
  SourceRepository.get().object<FileVariantMaker>('@proteinjs/db-file/FileVariantMaker');

/**
 * What a derivation becomes when the registered maker could not make the variant of these
 * bytes: nothing is stored. Thrown by `FileStorage` in place of whatever the maker threw (the
 * maker's own one-line reason kept as `reason`), so the ingest door can report it to the caller
 * holding the bytes and the read path can tell it from a failure of the store or the database
 * (and serve the file itself). Read by shape ({@link FileVariantNotMade.is}), like
 * `FileCopyRefused`, so it holds across duplicate copies of this package.
 */
export class FileVariantNotMade extends Error {
  private static readonly NAME = 'FileVariantNotMade';
  /** Free text that reaches a message is one line and bounded. */
  private static readonly MAX_REASON_CHARS = 300;
  readonly fileId: string;
  readonly kind: FileVariantKind;
  readonly reason: string;

  constructor(fileId: string, kind: FileVariantKind, cause: unknown) {
    const reason = FileVariantNotMade.plain(cause);
    super(`No ${kind} variant could be made of file ${fileId}${reason ? `: ${reason}` : ''}`);
    this.name = FileVariantNotMade.NAME;
    Object.setPrototypeOf(this, FileVariantNotMade.prototype);
    this.fileId = fileId;
    this.kind = kind;
    this.reason = reason;
  }

  static is(error: unknown): error is FileVariantNotMade {
    return (error as { name?: unknown } | null | undefined)?.name === FileVariantNotMade.NAME;
  }

  private static plain(cause: unknown): string {
    const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
    const line = message.replace(/\s+/g, ' ').trim();
    return line.length > FileVariantNotMade.MAX_REASON_CHARS
      ? `${line.slice(0, FileVariantNotMade.MAX_REASON_CHARS)}…`
      : line;
  }
}
