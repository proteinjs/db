import { Loadable, SourceRepository } from '@proteinjs/reflection';

/**
 * The shared-content file leg (SHARING_EXPANSION §1): the caller may read a file when they may
 * read a row that references it. File rows are ScopedRecord — owner-private — but files get
 * EMBEDDED in shareable content (a shared thought's media nodes), where the content's own access
 * model says a share recipient may read them; a purely scoped row read as the access check
 * refuses every recipient (the shared-thought media defect, SHARING_EXPANSION §0).
 *
 * Content packages register resolvers that answer reachability through their own GRANT-FILTERED
 * reads — the same derivation the content itself is read through — so file access derives from
 * content access, revocation included, and file scope is never widened. Dependency direction is
 * the SharedThoughtResolver pattern: the interface lives here in db-file; implementations live
 * in the content packages above (thought, later chat) and are discovered via SourceRepository.
 *
 * Consulted by `FileStorage.getFile` only after the caller's scoped read MISSES (the owner never
 * pays for it), and it widens READS only: writes and deletes stay owner-scoped.
 */
export interface FileReachabilityResolver extends Loadable {
  /**
   * True when the CURRENT session user can read a row that references this file. Implementations
   * MUST resolve through their grant-filtered reads (e.g. the shared db) so a revoked grant
   * closes file access the same moment it closes content access.
   */
  canReadViaReference(fileId: string): Promise<boolean>;
}

export const getFileReachabilityResolvers = () =>
  SourceRepository.get().objects<FileReachabilityResolver>('@proteinjs/db-file/FileReachabilityResolver');
