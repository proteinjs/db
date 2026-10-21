import { File } from '../tables/FileTable';
import { FileStorage } from '../FileStorage';
import { FileStorageError } from '../FileStorageError';
import { ServiceRefusal } from '@proteinjs/service';
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
 * How long a client may keep a bytes-door answer, and the redirect to a signed URL, in its OWN cache
 * (`private` — the bytes are per caller: the owner's original, a recipient's copy — so never a shared
 * cache). One number for both shapes.
 */
export const FILE_RESPONSE_CLIENT_CACHE_MAX_AGE_S = 300;

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
 * THE BYTES DOOR ({@link serveBytes} — `GET /file/:id/bytes` and `GET /file/:id/variant/:kind/bytes`):
 * the same-origin answer a page can READ (a `fetch` whose body it may keep — a redirect to another
 * origin's signed URL is one it cannot read across origins, and whose URL it cannot keep past the
 * signature's life). It is the proxy shape, chosen: the signed URL is never minted, the bytes leave
 * through the same row read and the same egress decision as every other door, and the answer says
 * the browser may keep it privately (never a shared cache).
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
        response.setHeader('Cache-Control', `private, max-age=${FILE_RESPONSE_CLIENT_CACHE_MAX_AGE_S}`);
        response.redirect(302, signedUrl);
        return;
      }

      await FileResponder.proxy(file, fileStorage, request, response);
    } catch (error) {
      FileResponder.fail(file.id, error, response);
    }
  }

  /**
   * Serve `file`'s BYTES to `response` whatever the driver's URL space — never a redirect (the bytes
   * door, the class doc): the same egress as {@link serve}'s proxy shape, the answer marked keepable by
   * the client's own private cache.
   */
  static async serveBytes(file: File, request: FileRequest, response: FileResponse): Promise<void> {
    try {
      response.setHeader('Cache-Control', `private, max-age=${FILE_RESPONSE_CLIENT_CACHE_MAX_AGE_S}`);
      await FileResponder.proxy(file, new FileStorage(), request, response);
    } catch (error) {
      FileResponder.fail(file.id, error, response);
    }
  }

  /** The failure shapes a file read has: bytes missing behind a row (404), a refusal (its status, 404), anything else (500, logged). */
  static fail(fileId: string, error: unknown, response: FileResponse): void {
    if (FileStorageError.isNotFound(error)) {
      // The row is there and its bytes are not: the same answer as a row that is not there.
      response.status(404).send('File not found');
      return;
    }
    if (ServiceRefusal.is(error)) {
      // A deliberate refusal, not a failure — a file no copy can be made of is not there for anyone
      // but its owner (`FileStorage` answers every door the same 404 and keeps the maker's reason in
      // its own WARN). The same words as a row the caller cannot read; quiet, and never a 500.
      response.status(error.status).send('File not found');
      return;
    }
    console.error(`Error fetching file (${fileId}):`, error);
    response.status(500).send('Internal Server Error');
  }

  // ── Leaf helpers ─────────────────────────────────────────────────────────

  /**
   * The proxy shape: the bytes THIS caller is served (`getFileData` — the owner's original, the copy for
   * others otherwise), decoded to their true bytes, with the row's headers and HTTP Range honored.
   * Throws the storage's own failures for the public doors to map.
   */
  private static async proxy(
    file: File,
    fileStorage: FileStorage,
    request: FileRequest,
    response: FileResponse
  ): Promise<void> {
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
  }
}
