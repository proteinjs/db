import { File } from './tables/FileTable';
import type { FileStorageError } from './FileStorageError';

/**
 * Byte store behind `FileStorage`.
 *
 * Encoding contract: every `fileData`/`data` string crossing this interface is BASE64 of the
 * file's true bytes — for text and binary files alike. Drivers own their at-rest representation,
 * with one hard requirement: a driver that serves blobs directly to clients (`getSignedUrl`)
 * MUST store the true bytes at rest, because clients read its objects without any decode step.
 *
 * Error contract: a failed byte operation throws a {@link FileStorageError} — a code, a plain
 * message and the store's HTTP status where it has one — and NEVER the store client's own error
 * object or anything hanging off one (a request config, a request, a response, headers, a signed
 * URL): a client's error holds the request it made, and that request holds the driver's
 * credentials, so an application logging what it caught would write a live credential. Bytes that
 * are not there are reported as the `not-found` code on every read and overwrite, so callers
 * branch on one thing whichever driver is behind them (`deleteFile` alone treats missing bytes as
 * success — see its contract). A driver whose store IS the application's database
 * (`DbFileStorageDriver`) lets the database layer's own errors through unchanged: they are
 * already that layer's owned errors, and a transaction runner must see them to retry.
 */
export interface FileStorageDriver {
  createFile(file: File, fileData: string): Promise<void>;
  getFileData(fileId: string): Promise<string>;
  updateFileData(fileId: string, data: string): Promise<void>;
  updateFile?(file: File): Promise<void>;
  /**
   * Mint a short-lived, read-only URL for the file's bytes, when the driver's store has an
   * external URL space (e.g. GCS signed URLs). Serving rides this: `GET /file/:id` 302-redirects
   * to the minted URL, so clients get native Range/seek and caching and bytes stop transiting
   * the app server. Absent on drivers with no external URL space (`DbFileStorageDriver`) — their
   * bytes serve through the proxy route.
   */
  getSignedUrl?(fileId: string, options?: { ttlMs?: number }): Promise<string>;
  /**
   * Delete the stored bytes for `fileId`.
   *
   * Contract: idempotent on the goal state — bytes already gone is success, since file-row
   * deletes are retryable (a re-run after a half-completed prior attempt must not wedge on the
   * missing bytes). Every other failure throws loudly; the file row survives to drive a retry.
   */
  deleteFile(fileId: string): Promise<void>;
}
