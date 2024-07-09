import { File } from './tables/FileTable';

export interface FileStorageDriver {
  createFile(file: File, fileData: string): Promise<void>;
  getFileData(fileId: string): Promise<string>;
  updateFileData(fileId: string, data: string): Promise<void>;
  updateFile?(file: File): Promise<void>;
  deleteFile?(fileId: string): Promise<void>;
}
