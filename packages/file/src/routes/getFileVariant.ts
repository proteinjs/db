import { Route } from '@proteinjs/server-api';
import { UserAuth } from '@proteinjs/user';
import { FileStorage } from '../FileStorage';
import { FILE_VARIANT_KINDS, FileVariantKind } from '../FileVariantMaker';
import { FileResponder } from './FileResponder';

/**
 * Serves a file's VARIANT of a kind (`preview`, `stage`) — the one URL a surface that draws a
 * variant asks by (a plain `<img src>`, an off-DOM warm-up), whether or not the file has it yet:
 *
 * - the variant the row names is served as any File is ({@link FileResponder} — a 302 to ITS
 *   signed URL or the proxy, ITS headers; a non-owner is served ITS copy for others);
 * - a file WITHOUT the variant derives it on this first request, once, through the registered
 *   `FileVariantMaker` (`FileStorage.getVariant` — a file stored before the kind existed, or by a
 *   producer that did not derive it; the row's word is decided in one transaction, so a second
 *   request never re-derives);
 * - a file the maker does not apply to (a clip, a picture already small), or no maker at all, is
 *   served AS ITSELF — the consumer always gets a picture from this URL and never branches.
 *
 * Auth as `/file/:id`: logged-in, then the original's `getFile` read is the access decision (a
 * variant is readable by whoever can read its original). A kind the library does not know is a
 * 404, as a file that is not there.
 */
export const getFileVariant: Route = {
  path: '/file/:id/variant/:kind',
  method: 'get',
  onRequest: async (request, response): Promise<void> => {
    if (!UserAuth.isLoggedIn()) {
      response.status(401).send('User not logged in');
      return;
    }

    const fileId = request.params.id;
    const kind = request.params.kind as FileVariantKind;
    if (!FILE_VARIANT_KINDS.includes(kind)) {
      response.status(404).send('File not found');
      return;
    }
    try {
      const fileStorage = new FileStorage();
      // The variant first (its own access read of the original inside); the file itself only when
      // none applies — so the common request costs one row read before the bytes.
      const served = (await fileStorage.getVariant(fileId, kind)) ?? (await fileStorage.getFile(fileId));
      if (!served) {
        response.status(404).send('File not found');
        return;
      }
      await FileResponder.serve(served, request, response);
    } catch (error) {
      FileResponder.fail(fileId, error, response);
    }
  },
};
