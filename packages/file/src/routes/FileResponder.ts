import { File } from '../tables/FileTable';
import { FileStorage } from '../FileStorage';
import { FileStorageError } from '../FileStorageError';
import { FileCopyRefused } from '../FileCopyForOthers';
import { resolveByteRange } from './byteRange';

/** The express members the file routes touch — typed narrowly so the routes and their tests agree. */
export type FileRequest = { params: Record<string, string>; headers?: { range?: string } };
export type FileResponse = {
  status(code: number): { send(body: unknown): unknown };
  send(body: unknown): unknown;
  setHeader(name: string, value: string): void;
  redirect(status: number, url: string): void;
};

/**
 * THE ONE SERVING PATH for a file's bytes — `GET /file/:id` and `GET /file/:id/variant/:kind`
 * answer through it, so a variant is served exactly as any File is. Two shapes:
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
 *
 * WHICH bytes is `FileStorage`'s decision (`getSignedUrl` / `getFileData` substitute the copy
 * for others for anyone but the owner); the headers are the row's (its name and type). The
 * route decided existence and access before calling here (`FileStorage.getFile`).
 */
export class FileResponder {
  /** Serve `file` (a row the caller may read) to `response`; every failure shape mapped to its status. */
  static async serve(file: File, request: FileRequest, response: FileResponse): Promise<void> {
    const fileStorage = new FileStorage();
    try {
      const signedUrl = await fileStorage.getSignedUrl(file.id);
      if (signedUrl) {
        response.setHeader('Cache-Control', 'private, max-age=300');
        response.redirect(302, signedUrl);
        return;
      }

      const bytes = Buffer.from(await fileStorage.getFileData(file.id), 'base64');
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
      FileResponder.fail(file.id, error, response);
    }
  }

  /** The failure shapes a file read has: bytes missing behind a row (404), a copy refused (403), anything else (500, logged). */
  static fail(fileId: string, error: unknown, response: FileResponse): void {
    if (FileStorageError.isNotFound(error)) {
      // The row is there and its bytes are not: the same answer as a row that is not there.
      response.status(404).send('File not found');
      return;
    }
    if (FileCopyRefused.is(error)) {
      // A deliberate refusal, not a failure: no copy of this file can be made for anyone but its
      // owner (the maker said why on its own line). Quiet, and never a 500.
      response.status(403).send('File not available');
      return;
    }
    console.error(`Error fetching file (${fileId}):`, error);
    response.status(500).send('Internal Server Error');
  }
}
