import { File } from './tables/FileTable';

export interface FileStorageDriver {
  createFile(file: File, fileData: string): Promise<void>;
  getFileData(fileId: string): Promise<string>;
  updateFileData(fileId: string, data: string): Promise<void>;
  updateFile?(file: File): Promise<void>;
  /**
   * Delete the stored bytes for `fileId`.
   *
   * Contract: idempotent on the goal state — bytes already gone is success, since file-row
   * deletes are retryable (a re-run after a half-completed prior attempt must not wedge on the
   * missing bytes). Every other failure throws loudly; the file row survives to drive a retry.
   */
  deleteFile(fileId: string): Promise<void>;
}
