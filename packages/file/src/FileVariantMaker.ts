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
