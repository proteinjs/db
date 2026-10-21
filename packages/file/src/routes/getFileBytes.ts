import { Route } from '@proteinjs/server-api';
import { UserAuth } from '@proteinjs/user';
import { getFileStorage } from '../FileStorage';
import { FileResponder } from './FileResponder';

/**
 * Serves a file's bytes THEMSELVES, same-origin, never a redirect (`FileResponder.serveBytes`) — the
 * door a page reads when it must keep the bytes (a copy of the file held on the device, say): a `fetch`
 * of `/file/:id` lands on another origin's signed URL whose body the page cannot read and whose URL it
 * cannot keep; this door answers the same bytes from the app's own origin.
 *
 * Auth exactly as `/file/:id` (the same row read is the access decision — `FileStorage.getFile`: the
 * caller's scoped read, else a variant's original, else the shared-content reachability leg); the
 * bytes leave through the same egress decision (the owner's original, the copy for others otherwise).
 * No new permission exists at this door: whoever may read the file by its URL may read its bytes here.
 */
export const getFileBytes: Route = {
  path: '/file/:id/bytes',
  method: 'get',
  onRequest: async (request, response): Promise<void> => {
    if (!UserAuth.isLoggedIn()) {
      response.status(401).send('User not logged in');
      return;
    }

    const fileId = request.params.id;
    try {
      const file = await getFileStorage().getFile(fileId);
      if (!file) {
        response.status(404).send('File not found');
        return;
      }
      await FileResponder.serveBytes(file, request, response);
    } catch (error) {
      FileResponder.fail(fileId, error, response);
    }
  },
};
