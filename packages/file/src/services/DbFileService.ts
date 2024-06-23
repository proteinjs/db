import { Service, serviceFactory } from '@proteinjs/service';
import { ScopedRecord } from '@proteinjs/user';
import { File } from '../tables/FileTable';

export const getDbFileService = serviceFactory<DbFileService>('@proteinjs/db-file/DbFileService');

export interface DbFileService extends Service {
  createFile(fileMetaData: Omit<File, keyof ScopedRecord>, fileData: string[]): Promise<File>;
  getFile(fileId: string): Promise<File>;
  getFileData(fileId: string): Promise<string[]>;
  updateFileData(fileId: string, data: string[]): Promise<void>;
  updateFile(file: Omit<File, keyof ScopedRecord>): Promise<void>;
  deleteFile(fileId: string): Promise<void>;
}