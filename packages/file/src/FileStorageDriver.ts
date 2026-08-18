import { File } from './tables/FileTable';

/**
 * Byte store behind `FileStorage`.
 *
 * Encoding contract: every `fileData`/`data` string crossing this interface is BASE64 of the
 * file's true bytes — for text and binary files alike. Drivers own their at-rest representation,
 * with one hard requirement: a driver that serves blobs directly to clients (`getSignedUrl`)
 * MUST store the true bytes at rest, because clients read its objects without any decode step.
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
