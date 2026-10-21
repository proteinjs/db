import { Route } from '@proteinjs/server-api';
import { UserAuth } from '@proteinjs/user';
import { FileStorage } from '../FileStorage';
import { FILE_VARIANT_KINDS, FileVariantKind } from '../FileVariantMaker';
import { FileResponder } from './FileResponder';

/**
 * Serves a file's VARIANT's bytes themselves, same-origin, never a redirect (`FileResponder.serveBytes`)
 * — the bytes door of `/file/:id/variant/:kind`: the variant the row names, derived on this first
 * request when absent, the file itself when none applies; exactly the row `GET /file/:id/variant/:kind`
 * serves, through the same read (`FileStorage.getVariant` — the original's access decision inside) and
 * the same egress (a non-owner is served the copy for others). A kind the library does not know is a
 * 404, as a file that is not there; a caller who may not read the original is answered the same.
 */
export const getFileVariantBytes: Route = {
  path: '/file/:id/variant/:kind/bytes',
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
      const served = (await fileStorage.getVariant(fileId, kind)) ?? (await fileStorage.getFile(fileId));
      if (!served) {
        response.status(404).send('File not found');
        return;
      }
      await FileResponder.serveBytes(served, request, response);
    } catch (error) {
      FileResponder.fail(fileId, error, response);
    }
  },
};
