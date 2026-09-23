import { Route } from '@proteinjs/server-api';
import { getFileStorage } from '../FileStorage';
import { UserAuth } from '@proteinjs/user';
import { FileResponder } from './FileResponder';

/**
 * Serves a file's bytes. Auth first: logged-in, then the `FileStorage.getFile` row read as the
 * access decision — the caller's SCOPED read, else a variant's original, else the shared-content
 * reachability leg (`FileReachabilityResolver`: the caller may read a file when they may read a
 * row that references it, e.g. a shared thought's media node). Then {@link FileResponder} — the
 * one serving path (a 302 to a signed URL, or the proxy with Range) every file route answers
 * through.
 */
export const getFile: Route = {
  path: '/file/:id',
  method: 'get',
  onRequest: async (request, response): Promise<void> => {
    if (!UserAuth.isLoggedIn()) {
      response.status(401).send('User not logged in');
      return;
    }

    const fileId = request.params.id;
    try {
      // The file row decides existence (a scoped-or-reachable read, so it is also the access check).
      const file = await getFileStorage().getFile(fileId);
      if (!file) {
        response.status(404).send('File not found');
        return;
      }
      await FileResponder.serve(file, request, response);
    } catch (error) {
      FileResponder.fail(fileId, error, response);
    }
  },
};
