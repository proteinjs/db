import { Reference, getDbAsSystem } from '@proteinjs/db';
import { ScopedRecord, UserRepo, getScopedDb, getScopedDbAsSystem } from '@proteinjs/user';
import { File } from './tables/FileTable';
import { tables } from './tables/tables';
import { FileStorageService, getFileStorageService } from './services/FileStorageService';
import { FileStorageDriver } from './FileStorageDriver';
import { getFileReachabilityResolvers } from './FileReachabilityResolver';
import { FileCopyRefused, getFileCopyForOthers } from './FileCopyForOthers';
import {
  FILE_VARIANT_KINDS,
  FileVariant,
  FileVariantKind,
  FileVariantNotMade,
  getFileVariantMaker,
} from './FileVariantMaker';
import { Loadable, SourceRepository } from '@proteinjs/reflection';
import { Logger } from '@proteinjs/logger';
import { ServiceRefusal } from '@proteinjs/service';
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
  /** The read path's derivations running in this process, by file and kind — see {@link deriveOnce}. */
  private static derivations = new Map<string, Promise<string | undefined>>();

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
   * Three legs, cheapest first: the caller's own file resolves by the SCOPED read. When that
   * misses, the derived leg: a VARIANT the seam made (`File.variantOf`) is readable by whoever
   * can read its original — this same decision, asked of the original — so a variant derived
   * after the content was placed (no content row names it) is reachable by exactly the readers
   * of the file it was made from; one system point read decides whether the row is a variant at
   * all. Last, the shared-content leg asks the registered {@link FileReachabilityResolver}s
   * whether the caller can read a row that REFERENCES the file (a shared thought's media node) —
   * content access confers file access, through the content's own grant-filtered read, never by
   * widening file scope. No leg vouching means the miss stands. Reads only: writes/deletes stay
   * scoped.
   * @param fileId - The `id` of the file.
   * @returns The file metadata, or `undefined` when the caller can neither own nor reach it.
   */
  async getFile(fileId: string): Promise<File> {
    const db = getScopedDb();
    const file = await db.get(tables.File, { id: fileId });
    if (file) {
      return file;
    }

    const row = await getScopedDbAsSystem().get(tables.File, { id: fileId });
    if (!row) {
      return undefined as unknown as File;
    }
    if (row.variantOf?._id) {
      // A variant's reachability is its original's — the copy for others carries no `variantOf`,
      // so its own id stays nobody's but the owner's.
      return (await this.getFile(row.variantOf._id)) ? row : (undefined as unknown as File);
    }

    for (const resolver of getFileReachabilityResolvers()) {
      if (await resolver.canReadViaReference(fileId)) {
        // Reachability established through the caller's grant-filtered content read — the row
        // itself lives in the owner's scope, so it is served via system read.
        return row;
      }
    }

    return undefined as unknown as File;
  }

  /**
   * The variant of this kind of a file — the derived File the row names, or one made now, ONCE,
   * by the registered {@link FileVariantMaker} (the read path's door, behind
   * `GET /file/:id/variant/:kind`: a file made before the seam existed, or by a producer that did
   * not derive it, gets its variant on the first request from a surface that draws it; every
   * later request is served the same row without the maker). Server-only, like `getSignedUrl` —
   * the browser asks by URL, never by service call. Access is the original's ({@link getFile});
   * the variant is stored as the owner's own File whoever's read made it, and is served like any
   * File afterwards — with the same non-owner copy rule.
   * @returns The variant's File row, or `undefined` when the caller cannot read the original, no
   *          maker is registered, the maker does not apply to this file for this kind, or the
   *          maker could not make it of these bytes (the consumer then draws the original).
   */
  async getVariant(fileId: string, kind: FileVariantKind): Promise<File | undefined> {
    const file = await this.getFile(fileId);
    if (!file) {
      return undefined;
    }
    const named = file[kind]?._id;
    if (named) {
      return await getScopedDbAsSystem().get(tables.File, { id: named });
    }
    const maker = getFileVariantMaker();
    if (!maker || !maker.appliesTo(file, kind)) {
      return undefined;
    }
    const variantId = await this.deriveOnce(file, kind);
    return variantId ? await getScopedDbAsSystem().get(tables.File, { id: variantId }) : undefined;
  }

  /**
   * Make and store every variant the registered maker applies to, with the original's bytes in
   * hand (the ingest's door — one decode of bytes just stored, never a re-read). Each is named on
   * the row; a kind the maker does not apply to is left unset (the read path may derive it later
   * if the maker's rule changes). With no maker registered nothing is made.
   * @returns The caller's file row with each variant made here named on it (the row as the caller
   *          holds it, not a re-read — an unset column stays unset), and the variant Files made.
   */
  async deriveVariants(
    file: File,
    bytes: Buffer
  ): Promise<{ file: File; variants: Partial<Record<FileVariantKind, File>> }> {
    const maker = getFileVariantMaker();
    const variants: Partial<Record<FileVariantKind, File>> = {};
    const named: Partial<Pick<File, FileVariantKind>> = {};
    if (maker) {
      for (const kind of FILE_VARIANT_KINDS) {
        if (!file[kind]?._id && maker.appliesTo(file, kind)) {
          const variantId = await this.makeVariant(file, kind, bytes);
          variants[kind] = await getScopedDbAsSystem().get(tables.File, { id: variantId });
          named[kind] = new Reference<File>(tables.File.name, variantId);
        }
      }
    }
    return { file: { ...file, ...named }, variants };
  }

  /**
   * Retrieves the data chunks associated with a given file.
   *
   * Gated on the {@link getFile} row read — the same two-legged access decision every serving
   * path derives from (the caller's SCOPED read, else shared-content reachability), so bytes are
   * exactly as reachable as the row that names them. The gate lives here because this is the
   * browser-facing service boundary (`FileStorageService` is `allUsers`) and the driver byte ops
   * below are deliberately unscoped. Server-side doors that make their OWN documented access
   * decision (an attachment door keyed by a record's linkage, say) serve through
   * {@link getAuthorizedFileData} — the same owner-or-copy bytes, without this gate.
   *
   * WHICH bytes: the owner's read serves the original; anyone else's — a read that reached the
   * file through the shared-content leg — serves the {@link FileCopyForOthers} copy
   * ({@link servedFileId}): the same substitution `getSignedUrl` makes, so the proxy route, the
   * signed-URL route and every server-side reader of this door agree.
   * @param fileId - The `id` of the file.
   * @returns The file data as a single string.
   * @throws When the file row does not exist or is not readable by the caller — the same named
   *         miss either way, so existence is not leaked to unauthorized callers; a ServiceRefusal
   *         (404) when the caller is not the owner and no copy can be made ({@link servedFileId}).
   */
  async getFileData(fileId: string): Promise<string> {
    const file = await this.getFile(fileId);
    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    return await FileStorage.getDriver().getFileData(await this.servedFileId(file));
  }

  /**
   * The bytes THIS caller is served for a file a server-side door has ALREADY decided the caller
   * may read, by its own documented rule (an attachment door keyed by a record's linkage, say —
   * a read neither the caller's scope nor a {@link FileReachabilityResolver} would open). The
   * door vouches for access; this decides WHICH bytes, exactly as {@link getFileData} does: the
   * original for the file's owner, the {@link FileCopyForOthers} copy for anyone else — the same
   * copy, made once and named on the row, that every other door serves them. Server-only (not
   * part of the browser-facing `FileStorageService`), so the rule that opens the file stays the
   * door's.
   * @param file - The file's row, as the door read it (its `scope` names the owner).
   * @returns The file data as a single string.
   * @throws ServiceRefusal (404) when the caller is not the owner and no copy can be made — the same
   *         refusal every door gives ({@link servedFileId}).
   */
  async getAuthorizedFileData(file: File): Promise<string> {
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
   * @throws When the file row does not exist or is not readable by the caller; a ServiceRefusal
   *         (404) when the caller is not the owner and no copy can be made ({@link servedFileId}).
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
   * New bytes make every derived File stale — the copy others were served, the preview, the
   * stage variant: each is dropped here — the row forgets it, then its row (and, through the
   * delete watcher, its bytes) goes — and the next read that wants one makes a fresh one.
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
    await this.dropDerivedFiles(file);
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
   *
   * ONE REFUSAL, EVERY DOOR: when no copy can be made (the seam's {@link FileCopyRefused}), the file
   * is served to no one but its owner, so to this caller it is not there — a `ServiceRefusal(404)`
   * carrying the seam's reason, thrown here so the browser service, `GET /file/:id` in both its
   * shapes and the server-side door answer the same by construction: the service router answers
   * 404, the executor logs one WARN (a refusal, never a failure), the route answers
   * `404 File not found` — the same as a row it cannot read — and nothing leaks about existence.
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
    try {
      return await this.makeCopyForOthers(file);
    } catch (error) {
      if (FileCopyRefused.is(error)) {
        throw new ServiceRefusal(404, error.message);
      }
      throw error;
    }
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

  /**
   * The read path's derivation, ONCE per file and kind at a time in this process: the readers
   * that ask for the same absent variant while one derives (a shared document opened by many on
   * one tick — every face asks the same URL) wait for that derivation's answer instead of each
   * reading the original, encoding it and storing an object the row's word would then discard.
   * Across processes the row's word in one transaction ({@link makeVariant}) still decides: this
   * bounds the cost, that bounds the outcome. A maker that cannot make the variant of these
   * bytes (a picture its decoder cannot read) answers `undefined` — nothing is stored, the reader
   * draws the file itself, the next reader asks again — said in the log, never as a failed read;
   * any other failure (the store, the database) is the reader's as it would be for any File.
   */
  private deriveOnce(file: File, kind: FileVariantKind): Promise<string | undefined> {
    const key = `${file.id}:${kind}`;
    const running = FileStorage.derivations.get(key);
    if (running) {
      return running;
    }
    const derivation = (async () => {
      const original = Buffer.from(await FileStorage.getDriver().getFileData(file.id), 'base64');
      try {
        return await this.makeVariant(file, kind, original);
      } catch (error) {
        if (!FileVariantNotMade.is(error)) {
          throw error;
        }
        new Logger({ name: 'FileStorage' }).warn({
          message: `No ${kind} variant could be made of file ${file.id}; the file itself is served`,
          obj: { reason: error.reason },
        });
        return undefined;
      }
    })().finally(() => FileStorage.derivations.delete(key));
    FileStorage.derivations.set(key, derivation);
    return derivation;
  }

  /**
   * Makes the variant (the maker's answer from the original's bytes), stores it as a File in the
   * OWNER's scope naming its original, and names it on the original's row. Two readers may derive
   * the same kind at once: the row's word wins — decided in ONE transaction, exactly as the copy
   * for others is named — and the variant that lost is deleted after the commit. The maker's own
   * failure (it could not make the variant of these bytes) is thrown as {@link FileVariantNotMade}
   * with the maker's reason, so the doors can tell it from a failure of the store or the database;
   * nothing is stored on it.
   * @returns The id of the variant the row names.
   */
  private async makeVariant(file: File, kind: FileVariantKind, bytes: Buffer): Promise<string> {
    const maker = getFileVariantMaker()!;
    const driver = FileStorage.getDriver();
    let made: FileVariant;
    try {
      made = await maker.make(file, bytes, kind);
    } catch (cause) {
      // The maker's contract: a throw means no variant can be made of these bytes.
      throw new FileVariantNotMade(file.id, kind, cause);
    }
    // As system, in the OWNER's scope: the variant is the owner's file (their storage, their purge).
    const system = getDbAsSystem();
    const variant = await system.insert(tables.File, {
      name: `(${kind}) ${file.name}`,
      type: made.type,
      size: made.bytes.length,
      ...(made.width !== undefined ? { width: made.width } : {}),
      ...(made.height !== undefined ? { height: made.height } : {}),
      variantOf: new Reference<File>(tables.File.name, file.id),
      scope: file.scope,
    });
    await driver.createFile(variant, made.bytes.toString('base64'));

    const named = await system.runTransaction(async () => {
      const current = await system.get(tables.File, { id: file.id });
      if (current?.[kind]?._id) {
        return current[kind]!._id!;
      }
      await system.update(tables.File, { id: file.id, [kind]: new Reference<File>(tables.File.name, variant.id) });
      return variant.id;
    });
    if (named !== variant.id) {
      // Outside the transaction: the row's delete takes the bytes with it (the delete watcher), a
      // side effect that must not ride a transaction the runner may retry.
      await system.delete(tables.File, { id: variant.id });
    }
    return named;
  }

  /**
   * The row forgets each derived File first (nothing serves a copy or a variant the row no longer
   * names), then their rows go — the bytes with them, through the delete watcher: the copy for
   * others and every variant kind, one rule.
   */
  private async dropDerivedFiles(file: File): Promise<void> {
    const seats: Array<'copyForOthers' | FileVariantKind> = ['copyForOthers', ...FILE_VARIANT_KINDS];
    const stale = seats.filter((seat) => !!file[seat]?._id);
    if (stale.length === 0) {
      return;
    }
    const system = getDbAsSystem();
    const forgotten: Partial<File> & { id: string } = { id: file.id };
    for (const seat of stale) {
      forgotten[seat] = null;
    }
    await system.update(tables.File, forgotten);
    for (const seat of stale) {
      await system.delete(tables.File, { id: file[seat]!._id! });
    }
  }
}
