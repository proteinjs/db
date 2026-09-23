import { Reference, getDbAsSystem } from '@proteinjs/db';
import { ScopedRecord, UserRepo, getScopedDb, getScopedDbAsSystem } from '@proteinjs/user';
import { File } from './tables/FileTable';
import { tables } from './tables/tables';
import { FileStorageService, getFileStorageService } from './services/FileStorageService';
import { FileStorageDriver } from './FileStorageDriver';
import { getFileReachabilityResolvers } from './FileReachabilityResolver';
import { FileCopyRefused, getFileCopyForOthers } from './FileCopyForOthers';
import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { Logger } from '@proteinjs/logger';
import { DbFileStorageDriver } from './DbFileStorageDriver';

/**
 * A convenience factory function so code using this is portable (can be used in server or browser).
 * @returns an instance of the `FileStorageService` when called from the browser, and an instance of `FileStorage` otherwise
 * */
export const getFileStorage = () =>
  typeof self === 'undefined' ? new FileStorage() : (getFileStorageService() as FileStorage);

/**
 * A convenience factory to provide a default `FileStorageDriver`
 */
export interface DefaultFileStorageDriverFactory extends Loadable {
  getDriver(): FileStorageDriver;
}

/**
 * A simple api for file storage.
 * File metadata is stored in the `FileTable`.
 * File data is stored by the `FileStorageDriver`.
 */
export class FileStorage implements FileStorageService {
  private static driver: FileStorageDriver;

  public serviceMetadata = {
    auth: {
      allUsers: true,
    },
  };

  /**
   * The `FileStorageDriver` for this process — provided by the `DefaultFileStorageDriverFactory`
   * implementation, defaulting to the `DbFileStorageDriver`. One resolution for every byte
   * operation (`FileStorage` and `FileStorageTableWatcher`), so bytes always live and die in the
   * same store.
   */
  static getDriver(): FileStorageDriver {
    if (!FileStorage.driver) {
      const defaultDriverFactory = SourceRepository.get().object<DefaultFileStorageDriverFactory>(
        '@proteinjs/db-file/DefaultFileStorageDriverFactory'
      );
      if (defaultDriverFactory) {
        FileStorage.driver = defaultDriverFactory.getDriver();
      } else {
        new Logger({ name: 'FileStorage' }).info({
          message: `Defaulting to DbFileStorageDriver since no FileStorageDriver was provided`,
        });
        FileStorage.driver = new DbFileStorageDriver();
      }
    }

    return FileStorage.driver;
  }

  /**
   * Creates a new file record and its associated data chunks.
   * @param fileMetaData - The file metadata (name, type, size).
   * @param fileData - The file data as a string.
   * @returns The created file record.
   */
  async createFile(fileMetaData: Omit<File, keyof ScopedRecord>, fileData: string): Promise<File> {
    const db = getScopedDb();
    const file = await db.insert(tables.File, fileMetaData);
    await FileStorage.getDriver().createFile(file, fileData);
    return file;
  }

  /**
   * Retrieves the metadata of a given file — THE file-read access decision every serving path
   * derives from (`/file/:id`, signed-URL minting, the browser service).
   *
   * Two legs: the caller's own file resolves by the SCOPED read; when that misses, the
   * shared-content leg asks the registered {@link FileReachabilityResolver}s whether the caller
   * can read a row that REFERENCES the file (a shared thought's media node) — content access
   * confers file access, through the content's own grant-filtered read, never by widening file
   * scope. No resolver vouching means the miss stands. Reads only: writes/deletes stay scoped.
   * @param fileId - The `id` of the file.
   * @returns The file metadata, or `undefined` when the caller can neither own nor reach it.
   */
  async getFile(fileId: string): Promise<File> {
    const db = getScopedDb();
    const file = await db.get(tables.File, { id: fileId });
    if (file) {
      return file;
    }

    for (const resolver of getFileReachabilityResolvers()) {
      if (await resolver.canReadViaReference(fileId)) {
        // Reachability established through the caller's grant-filtered content read — the row
        // itself lives in the owner's scope, so it is served via system read.
        return await getScopedDbAsSystem().get(tables.File, { id: fileId });
      }
    }

    return file;
  }

  /**
   * Retrieves the data chunks associated with a given file.
   *
   * Gated on the {@link getFile} row read — the same two-legged access decision every serving
   * path derives from (the caller's SCOPED read, else shared-content reachability), so bytes are
   * exactly as reachable as the row that names them. The gate lives here because this is the
   * browser-facing service boundary (`FileStorageService` is `allUsers`) and the driver byte ops
   * below are deliberately unscoped. Server-side doors that make their OWN documented access
   * decision (the avatar route, issue/ticket attachment doors) read bytes through
   * `FileStorage.getDriver()` instead.
   *
   * WHICH bytes: the owner's read serves the original; anyone else's — a read that reached the
   * file through the shared-content leg — serves the {@link FileCopyForOthers} copy
   * ({@link servedFileId}): the same substitution `getSignedUrl` makes, so the proxy route, the
   * signed-URL route and every server-side reader of this door agree.
   * @param fileId - The `id` of the file.
   * @returns The file data as a single string.
   * @throws When the file row does not exist or is not readable by the caller — the same named
   *         miss either way, so existence is not leaked to unauthorized callers.
   */
  async getFileData(fileId: string): Promise<string> {
    const file = await this.getFile(fileId);
    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    return await FileStorage.getDriver().getFileData(await this.servedFileId(file));
  }

  /**
   * Mint a short-lived, read-only URL for the file's bytes (server-only; not part of the
   * browser-facing `FileStorageService`). A signed URL is a bearer capability, so minting
   * verifies the caller can read the file row (the two-legged {@link getFile} read — own scope
   * or shared-content reachability) before signing — and signs the bytes THAT caller is served:
   * the original for the owner, the {@link FileCopyForOthers} copy for anyone else.
   * @param fileId - The `id` of the file.
   * @param options.ttlMs - How long the URL stays valid; the driver applies its default when omitted.
   * @returns The signed URL, or `undefined` when the driver has no external URL space
   *          (`DbFileStorageDriver`) — the caller then serves bytes through the proxy route.
   * @throws When the file row does not exist or is not readable by the caller.
   */
  async getSignedUrl(fileId: string, options?: { ttlMs?: number }): Promise<string | undefined> {
    const file = await this.getFile(fileId);
    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    const driver = FileStorage.getDriver();
    if (!driver.getSignedUrl) {
      return undefined;
    }

    return await driver.getSignedUrl(await this.servedFileId(file), options);
  }

  /**
   * Updates the data chunks associated with a given file.
   *
   * Gated on the caller's SCOPED row read — owner scope is the write grant on ScopedRecords
   * (the same authorization a scoped row update enforces). Deliberately STRICTER than
   * {@link getFileData}: the {@link FileReachabilityResolver} leg widens READS only, so a
   * share recipient who can read the bytes still cannot write them.
   *
   * New bytes make the copy others were served stale: it is dropped here — the row forgets it,
   * then the copy's row (and, through the delete watcher, its bytes) goes — and the next
   * non-owner read makes a fresh one.
   * @param fileId - The `id` of the file.
   * @param data - The new data string to replace the existing data.
   * @throws When the file row does not exist or is not writable by the caller — the same named
   *         miss either way, so existence is not leaked to unauthorized callers.
   */
  async updateFileData(fileId: string, data: string): Promise<void> {
    const db = getScopedDb();
    const file = await db.get(tables.File, { id: fileId });
    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    await FileStorage.getDriver().updateFileData(fileId, data);
    await this.dropCopyForOthers(file);
  }

  /**
   * Updates the metadata of a given file.
   * @param file - The updated file to persist.
   */
  async updateFile(file: Omit<File, keyof ScopedRecord>): Promise<void> {
    const db = getScopedDb();
    await db.update(tables.File, file);

    const driver = FileStorage.getDriver();
    if (driver.updateFile) {
      await driver.updateFile(file as File);
    }
  }

  /**
   * Deletes a file and its data.
   * The file data is deleted by the `FileStorageTableWatcher` when the row delete runs — the
   * watcher fires for every file-row delete path (this one, reference cascades, system sweeps),
   * so the bytes die with the row no matter where the delete originates.
   * @param fileId - The `id` of the file to delete.
   */
  async deleteFile(fileId: string): Promise<void> {
    const db = getScopedDb();
    await db.delete(tables.File, { id: fileId });
  }

  /**
   * The id whose bytes this caller is served: the file's own for its owner, or for a file with
   * no maker (or one the maker does not apply to); otherwise the {@link FileCopyForOthers} copy —
   * the one already named on the row, or made now, once, and named for every later read.
   */
  private async servedFileId(file: File): Promise<string> {
    if (this.ownedByCaller(file)) {
      return file.id;
    }
    if (file.copyForOthers?._id) {
      return file.copyForOthers._id;
    }
    const maker = getFileCopyForOthers();
    if (!maker || !maker.appliesTo(file)) {
      return file.id;
    }
    return await this.makeCopyForOthers(file);
  }

  /**
   * Whether the caller is the file's owner — the row's `scope` is the owner (the scoped read
   * {@link getFile} makes first is exactly `scope = the caller`), so a row {@link getFile} handed
   * back whose scope is someone else's was reached through the shared-content leg. A row with no
   * owner recorded serves as itself: there is no one to withhold it from.
   */
  private ownedByCaller(file: File): boolean {
    return !file.scope || file.scope === new UserRepo().getUser().id;
  }

  /**
   * Makes the copy (the maker's bytes, from the original's), stores it as a File in the owner's
   * scope and names it on the original's row. Two non-owners reading at once may both get here:
   * the row's word wins — decided in ONE transaction (the read of the row and the write of its
   * word together, so racing writers are serialized and the loser's transaction, retried, finds
   * the winner named) — and a copy that lost is deleted after the commit, the first is served.
   */
  private async makeCopyForOthers(file: File): Promise<string> {
    const maker = getFileCopyForOthers()!;
    const driver = FileStorage.getDriver();
    const original = Buffer.from(await driver.getFileData(file.id), 'base64');
    let copyBytes: Buffer;
    try {
      copyBytes = await maker.make(file, original);
    } catch (cause) {
      // The maker's contract: a throw means no copy can be made — the file is the owner's alone.
      throw new FileCopyRefused(file.id, cause);
    }
    // As system, in the OWNER's scope: the copy is the owner's file (their storage, their purge).
    const system = getDbAsSystem();
    const copy = await system.insert(tables.File, {
      name: file.name,
      type: file.type,
      size: copyBytes.length,
      ...(file.width !== undefined && file.width !== null ? { width: file.width } : {}),
      ...(file.height !== undefined && file.height !== null ? { height: file.height } : {}),
      ...(file.durationMs !== undefined && file.durationMs !== null ? { durationMs: file.durationMs } : {}),
      scope: file.scope,
    });
    await driver.createFile(copy, copyBytes.toString('base64'));

    const named = await system.runTransaction(async () => {
      const current = await system.get(tables.File, { id: file.id });
      if (current?.copyForOthers?._id) {
        return current.copyForOthers._id;
      }
      await system.update(tables.File, { id: file.id, copyForOthers: new Reference<File>(tables.File.name, copy.id) });
      return copy.id;
    });
    if (named !== copy.id) {
      // Outside the transaction: the row's delete takes the bytes with it (the delete watcher), a
      // side effect that must not ride a transaction the runner may retry.
      await system.delete(tables.File, { id: copy.id });
    }
    return named;
  }

  /** The row forgets its copy for others first (nothing serves a copy the row no longer names), then the copy's row goes — its bytes with it, through the delete watcher. */
  private async dropCopyForOthers(file: File): Promise<void> {
    const copyId = file.copyForOthers?._id;
    if (!copyId) {
      return;
    }
    const system = getDbAsSystem();
    await system.update(tables.File, { id: file.id, copyForOthers: null });
    await system.delete(tables.File, { id: copyId });
  }
}
