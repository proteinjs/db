import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { File } from './tables/FileTable';

/**
 * What a file becomes when it is served to someone who is not its owner.
 *
 * A file's bytes are the owner's, kept exactly as they arrived. When a read resolves through the
 * shared-content leg instead of the owner's own scope (`FileStorage.getFile`: a share recipient
 * reading a file a shared row references), `FileStorage` serves a COPY made by the one registered
 * maker — the package that knows the file's format decides what leaves in it (a picture's
 * location, say, does not). The copy is made once per file, stored as its own `File` in the
 * owner's scope and named on the original's row (`File.copyForOthers`), so every later read by
 * anyone but the owner serves the same bytes without remaking them; it is dropped when the
 * original's bytes change and deleted with the original.
 *
 * Dependency direction is the {@link FileReachabilityResolver} pattern: the seam lives here in
 * db-file, the one implementation lives in the package that knows media, discovered through the
 * SourceRepository. With no maker registered, everyone is served the original.
 */
export interface FileCopyForOthers extends Loadable {
  /**
   * Whether this file is served to others through a copy at all — decided from the row alone,
   * never from its bytes (a plain document serves as itself and costs no read). True means
   * {@link make} is called once, with the original's bytes, and its answer is what others get.
   */
  appliesTo(file: File): boolean;
  /** The bytes served to anyone but the owner, made from the original's. Throws when no copy can be made — the read then fails rather than serving the original. */
  make(file: File, bytes: Buffer): Promise<Buffer>;
}

export const getFileCopyForOthers = (): FileCopyForOthers | undefined =>
  SourceRepository.get().object<FileCopyForOthers>('@proteinjs/db-file/FileCopyForOthers');
