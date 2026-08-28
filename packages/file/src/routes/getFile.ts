import { Route } from '@proteinjs/server-api';
import { getFileStorage } from '../FileStorage';
import { UserAuth } from '@proteinjs/user';
import { resolveByteRange } from './byteRange';

/**
 * Serves a file's bytes. Auth first (logged-in + scoped row read), then one of two paths:
 *
 * - **302 redirect** to a short-lived signed URL when the driver's store has an external URL
 *   space (GCS). The app URL stays the one stable reference every `<img>`/`<video>`/chip uses;
 *   the client follows the redirect and reads the store directly — native Range/206 for video
 *   seeking, real caching, bytes never transit the app server. The redirect itself is cached
 *   briefly (client-private, well under the signed TTL) so repeated loads reuse one URL.
 * - **Proxy** for drivers with no external URL space (`DbFileStorageDriver`): the interface's
 *   base64 is decoded so every mime — binary or text — serves its true bytes, and HTTP Range
 *   is honored (206/416 via {@link resolveByteRange}) so a `<video>` can SEEK against a
 *   proxy-served blob — streaming parity with the signed-URL path instead of download-then-watch.
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
    const fileStorage = getFileStorage();
    try {
      // The file row decides existence (a scoped read, so it is also the access check).
      const file = await fileStorage.getFile(fileId);
      if (!file) {
        response.status(404).send('File not found');
        return;
      }

      const signedUrl = await fileStorage.getSignedUrl(fileId);
      if (signedUrl) {
        response.setHeader('Cache-Control', 'private, max-age=300');
        response.redirect(302, signedUrl);
        return;
      }

      const fileDataBase64 = await fileStorage.getFileData(fileId);
      const bytes = Buffer.from(fileDataBase64, 'base64');
      const safeFilename = encodeURIComponent(file.name);
      response.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
      response.setHeader('Content-Type', file.type);
      response.setHeader('Accept-Ranges', 'bytes');
      const range = resolveByteRange(request.headers?.range, bytes.length);
      if (range === 'unsatisfiable') {
        response.setHeader('Content-Range', `bytes */${bytes.length}`);
        response.status(416).send('Range Not Satisfiable');
        return;
      }
      if (range) {
        response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${bytes.length}`);
        response.status(206).send(bytes.subarray(range.start, range.end + 1));
        return;
      }
      response.send(bytes);
    } catch (error) {
      console.error(`Error fetching file (${fileId}):`, error);
      response.status(500).send('Internal Server Error');
    }
  },
};
