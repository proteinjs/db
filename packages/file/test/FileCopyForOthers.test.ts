import { getDbAsSystem, QueryBuilderFactory } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { UserAuth, UserRepo, User } from '@proteinjs/user';
import { File } from '../src/tables/FileTable';
import { tables } from '../src/tables/tables';
import { FileStorage } from '../src/FileStorage';
import { ServiceRefusal } from '@proteinjs/service';
import { FileStorageDriver } from '../src/FileStorageDriver';
import { getFile } from '../src/routes/getFile';
import { FileTestEnvironment } from './FileTestEnvironment';

/**
 * A file's bytes are the owner's, kept as they arrived; what anyone ELSE is served is a copy the
 * registered maker derives — made once, stored as its own File in the owner's scope, named on the
 * original's row, dropped when the bytes change, deleted with the original. This suite proves the
 * seam contract with a stub maker (the real one — a picture without its location — lives in the
 * package that knows media): who gets which bytes, through the service door and both shapes of
 * the route; that the copy is cached and its cache never crosses to the owner; how it dies.
 *
 * The stub maker marks the bytes it makes: the original carries `LOCATION-MARKER` (what a phone
 * photo's GPS block is to the real maker), the copy does not.
 */

const LOCATION_MARKER = Buffer.from('LOCATION-MARKER');
/** Every byte value once, then the marker — a payload the copy must be seen to differ from. */
const originalBytes = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), LOCATION_MARKER]);
const copyOf = (bytes: Buffer): Buffer => Buffer.from(bytes.subarray(0, bytes.length - LOCATION_MARKER.length));

/** In-memory proxy-shape driver (no signed URLs) — the DbFileStorageDriver serving shape. */
class ProxyDriver implements FileStorageDriver {
  readonly store = new Map<string, Buffer>();

  async createFile(file: File, fileData: string): Promise<void> {
    this.store.set(file.id, Buffer.from(fileData, 'base64'));
    await atBarrier(); // the racing case: every copy's bytes are stored before any row is asked its word
  }

  async getFileData(fileId: string): Promise<string> {
    const data = this.store.get(fileId);
    if (data === undefined) {
      throw new Error(`No such object: ${fileId}`);
    }
    return data.toString('base64');
  }

  async updateFileData(fileId: string, data: string): Promise<void> {
    this.store.set(fileId, Buffer.from(data, 'base64'));
  }

  async deleteFile(fileId: string): Promise<void> {
    this.store.delete(fileId);
  }
}

/** Proxy driver plus a signed-URL mint that names the object it signs — the GCS serving shape. */
class SignedUrlDriver extends ProxyDriver {
  async getSignedUrl(fileId: string): Promise<string> {
    return `https://signed.test/blob/${fileId}?sig=test`;
  }
}

class ResponseRecorder {
  statusCode?: number;
  body?: unknown;
  redirectUrl?: string;
  headers: Record<string, string> = {};

  status(code: number): ResponseRecorder {
    this.statusCode = code;
    return this;
  }

  send(body: unknown): ResponseRecorder {
    this.body = body;
    return this;
  }

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  redirect(status: number, url: string): void {
    this.statusCode = status;
    this.redirectUrl = url;
  }
}

type RouteRequest = Parameters<typeof getFile.onRequest>[0];
type RouteResponse = Parameters<typeof getFile.onRequest>[1];

const invokeRoute = async (fileId: string): Promise<ResponseRecorder> => {
  const response = new ResponseRecorder();
  await getFile.onRequest(
    { params: { id: fileId }, headers: {} } as unknown as RouteRequest,
    response as unknown as RouteResponse
  );
  return response;
};

const testEnv = new FileTestEnvironment();
type UserAuthInternals = { userRepo?: unknown };
type SourceRepositoryInternals = { objectCache: Record<string, unknown[]> };
const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;
/** The row's seat for the copy — read by name so the suite states the contract, not the type. */
type FileWithCopy = File & { copyForOthers?: { _id: string | null } | null };

let owner: User;
let recipient: User;
const reachableFileIds = new Set<string>();
/** Every call the maker took: which file, and the bytes it was handed. */
let makerCalls: Array<{ fileId: string; bytes: Buffer }> = [];
/** What the stub maker applies to — the suite's own rule (the real maker's is "pictures and clips"). */
let makerAppliesTo = (file: File): boolean => file.type.startsWith('image/');
let makerFails = false;
/**
 * A barrier for the racing case: with `makerBarrier = n`, the stub maker holds every call until n
 * calls are inside it, then answers them all on the same tick — so the reads that follow (the
 * copy's row, its bytes, the row's word) run in lockstep, the tightest race the seam can meet.
 */
let makerBarrier = 0;
let makerWaiting: Array<() => void> = [];
/** Hold until `makerBarrier` callers are here, then release them all on one tick (no-op when 0). */
const atBarrier = async (): Promise<void> => {
  if (makerBarrier <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    makerWaiting.push(resolve);
    if (makerWaiting.length >= makerBarrier) {
      const release = makerWaiting;
      makerWaiting = [];
      release.forEach((go) => go());
    }
  });
};

const registerMaker = () => {
  objectCache()['@proteinjs/db-file/FileCopyForOthers'] = [
    {
      appliesTo: (file: File) => makerAppliesTo(file),
      make: async (file: File, bytes: Buffer) => {
        makerCalls.push({ fileId: file.id, bytes: Buffer.from(bytes) });
        await atBarrier();
        if (makerFails) {
          throw new Error('no copy can be made of this file');
        }
        return copyOf(bytes);
      },
    },
  ];
};

beforeAll(async () => {
  await testEnv.beforeAll();
  objectCache()['@proteinjs/user-auth/AuthenticatedUserRepo'] = [new UserRepo()];
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  objectCache()['@proteinjs/db-file/FileReachabilityResolver'] = [
    { canReadViaReference: async (fileId: string) => reachableFileIds.has(fileId) },
  ];
  registerMaker();
  owner = await testEnv.createUser({ name: 'File owner', email: 'copy-owner@test.local' });
  recipient = await testEnv.createUser({ name: 'Share recipient', email: 'copy-recipient@test.local' });
  testEnv.actAs(owner);
});

afterAll(async () => {
  delete objectCache()['@proteinjs/db-file/FileReachabilityResolver'];
  delete objectCache()['@proteinjs/db-file/FileCopyForOthers'];
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  await testEnv.afterAll();
});

beforeEach(() => {
  reachableFileIds.clear();
  makerCalls = [];
  makerAppliesTo = (file: File) => file.type.startsWith('image/');
  makerFails = false;
  makerBarrier = 0;
  makerWaiting = [];
  registerMaker();
  testEnv.actAs(owner);
});

const createOwnerFile = async (name: string, type: string, bytes = originalBytes): Promise<File> =>
  await new FileStorage().createFile({ name, type, size: bytes.length } as File, bytes.toString('base64'));

const rowAsSystem = async (fileId: string): Promise<FileWithCopy | undefined> =>
  (await getDbAsSystem().get(tables.File, { id: fileId })) as FileWithCopy | undefined;

const bytesAs = async (user: User, fileId: string): Promise<Buffer> => {
  testEnv.actAs(user);
  return Buffer.from(await new FileStorage().getFileData(fileId), 'base64');
};

const fileRowsInScope = async (scope: string): Promise<File[]> =>
  await getDbAsSystem().query(
    tables.File,
    new QueryBuilderFactory().getQueryBuilder(tables.File).condition({ field: 'scope', operator: '=', value: scope })
  );

describe('the copy for others — the service door (proxy serving)', () => {
  const driver = new ProxyDriver();

  beforeAll(() => {
    testEnv.setDriver(driver);
  });

  it('the owner is served the original, and no copy is made for them', async () => {
    const file = await createOwnerFile('mine.jpg', 'image/jpeg');

    const served = await bytesAs(owner, file.id);

    expect(served.equals(originalBytes)).toBe(true);
    expect(makerCalls).toEqual([]);
    expect((await rowAsSystem(file.id))!.copyForOthers?._id ?? null).toBeNull();
  });

  it("a recipient the content reaches is served the maker's copy — the original's bytes never leave to them", async () => {
    const file = await createOwnerFile('shared.jpg', 'image/jpeg');
    reachableFileIds.add(file.id);

    const served = await bytesAs(recipient, file.id);

    expect(served.includes(LOCATION_MARKER)).toBe(false);
    expect(served.equals(copyOf(originalBytes))).toBe(true);
    expect(makerCalls.map((call) => call.fileId)).toEqual([file.id]);
    expect(makerCalls[0].bytes.equals(originalBytes)).toBe(true);
  });

  it("the copy is a File of the OWNER's, named on the original's row, with the original's name, type and dimensions", async () => {
    const file = await createOwnerFile('framed.jpg', 'image/jpeg');
    await getDbAsSystem().update(tables.File, { id: file.id, width: 640, height: 480 });
    reachableFileIds.add(file.id);

    await bytesAs(recipient, file.id);

    const row = (await rowAsSystem(file.id))!;
    const copyId = row.copyForOthers?._id;
    expect(copyId).toBeTruthy();
    const copy = (await rowAsSystem(copyId!))!;
    expect(copy.scope).toEqual(owner.id);
    expect([copy.name, copy.type, copy.size, copy.width, copy.height]).toEqual([
      'framed.jpg',
      'image/jpeg',
      copyOf(originalBytes).length,
      640,
      480,
    ]);
    expect(driver.store.get(copyId!)!.equals(copyOf(originalBytes))).toBe(true);
    // The original is untouched: its bytes, its size.
    expect(driver.store.get(file.id)!.equals(originalBytes)).toBe(true);
    expect(row.size).toEqual(originalBytes.length);
  });

  it('the copy is made ONCE: every later non-owner read serves the same copy without the maker', async () => {
    const file = await createOwnerFile('popular.jpg', 'image/jpeg');
    reachableFileIds.add(file.id);

    await bytesAs(recipient, file.id);
    const copyId = (await rowAsSystem(file.id))!.copyForOthers!._id;
    const again = await bytesAs(recipient, file.id);
    const onceMore = await bytesAs(recipient, file.id);

    expect(again.equals(copyOf(originalBytes))).toBe(true);
    expect(onceMore.equals(copyOf(originalBytes))).toBe(true);
    expect(makerCalls).toHaveLength(1);
    expect((await rowAsSystem(file.id))!.copyForOthers!._id).toEqual(copyId);
  });

  it("TWO NON-OWNERS RACING: both are served the copy, ONE copy row survives in the owner's scope, the row names it, the loser's object is gone", async () => {
    const file = await createOwnerFile('raced.jpg', 'image/jpeg');
    reachableFileIds.add(file.id);
    const readers = 4;
    makerBarrier = readers;
    // Warm the driver's session pool so the readers' round trips really overlap (a cold pool serializes them).
    await Promise.all(Array.from({ length: readers * 2 }, () => rowAsSystem(file.id)));

    testEnv.actAs(recipient);
    const served = await Promise.all(Array.from({ length: readers }, () => new FileStorage().getFileData(file.id)));

    for (const bytes of served) {
      expect(Buffer.from(bytes, 'base64').equals(copyOf(originalBytes))).toBe(true);
    }
    expect(makerCalls).toHaveLength(readers); // all raced into the maker; the contract is about what SURVIVES
    const named = (await rowAsSystem(file.id))!.copyForOthers!._id!;
    const copies = (await fileRowsInScope(owner.id)).filter((row) => row.id !== file.id && row.name === 'raced.jpg');
    expect(copies.map((row) => row.id)).toEqual([named]);
    // The loser's object is gone: every object in the store belongs to a row that still exists.
    const liveIds = new Set(
      (await getDbAsSystem().query(tables.File, new QueryBuilderFactory().getQueryBuilder(tables.File))).map(
        (row) => row.id
      )
    );
    expect(Array.from(driver.store.keys()).filter((id) => !liveIds.has(id))).toEqual([]);
    expect(await fileRowsInScope(recipient.id)).toEqual([]);

    makerBarrier = 0;
    const again = await bytesAs(recipient, file.id);
    expect(again.equals(copyOf(originalBytes))).toBe(true);
    expect(makerCalls).toHaveLength(readers);
  });

  it("THE CACHE NEVER CROSSES TO THE OWNER: once a copy exists, the owner's read still serves the original", async () => {
    const file = await createOwnerFile('still-mine.jpg', 'image/jpeg');
    reachableFileIds.add(file.id);
    await bytesAs(recipient, file.id);
    expect((await rowAsSystem(file.id))!.copyForOthers?._id).toBeTruthy();

    const served = await bytesAs(owner, file.id);

    expect(served.equals(originalBytes)).toBe(true);
    expect(served.includes(LOCATION_MARKER)).toBe(true);
  });

  it('a file the maker does not apply to serves as itself to a recipient — no bytes read, no copy made', async () => {
    const file = await createOwnerFile('notes.pdf', 'application/pdf');
    reachableFileIds.add(file.id);
    const rowsBefore = (await fileRowsInScope(owner.id)).length;

    const served = await bytesAs(recipient, file.id);

    expect(served.equals(originalBytes)).toBe(true);
    expect(makerCalls).toEqual([]);
    expect((await rowAsSystem(file.id))!.copyForOthers?._id ?? null).toBeNull();
    expect((await fileRowsInScope(owner.id)).length).toEqual(rowsBefore);
  });

  it("the copy's own id is the owner's alone: a recipient cannot reach it, the owner can", async () => {
    const file = await createOwnerFile('guarded.jpg', 'image/jpeg');
    reachableFileIds.add(file.id);
    await bytesAs(recipient, file.id);
    const copyId = (await rowAsSystem(file.id))!.copyForOthers!._id!;

    testEnv.actAs(recipient);
    await expect(new FileStorage().getFileData(copyId)).rejects.toThrow('File not found');
    testEnv.actAs(owner);
    expect(Buffer.from(await new FileStorage().getFileData(copyId), 'base64').equals(copyOf(originalBytes))).toBe(true);
  });

  it('when no copy can be made, the recipient is served NOTHING — never the original', async () => {
    const file = await createOwnerFile('unrewritable.jpg', 'image/jpeg');
    reachableFileIds.add(file.id);
    makerFails = true;

    testEnv.actAs(recipient);
    await expect(new FileStorage().getFileData(file.id)).rejects.toThrow('no copy can be made');
    expect((await rowAsSystem(file.id))!.copyForOthers?._id ?? null).toBeNull();
    expect(Array.from(driver.store.keys())).toContain(file.id);
    expect(
      (await fileRowsInScope(owner.id)).find((row) => row.id !== file.id && row.name === 'unrewritable.jpg')
    ).toBeUndefined();
  });

  it('with no maker registered at all, a recipient is served the original (the seam is opt-in)', async () => {
    objectCache()['@proteinjs/db-file/FileCopyForOthers'] = [];
    const file = await createOwnerFile('unguarded.jpg', 'image/jpeg');
    reachableFileIds.add(file.id);

    const served = await bytesAs(recipient, file.id);

    expect(served.equals(originalBytes)).toBe(true);
    expect((await rowAsSystem(file.id))!.copyForOthers?._id ?? null).toBeNull();
  });

  it("NEW BYTES DROP THE COPY: after the owner rewrites the file, the recipient's next read is a fresh copy of the new bytes, the old copy's row and bytes gone", async () => {
    const file = await createOwnerFile('edited.jpg', 'image/jpeg');
    reachableFileIds.add(file.id);
    await bytesAs(recipient, file.id);
    const staleCopyId = (await rowAsSystem(file.id))!.copyForOthers!._id!;
    const newBytes = Buffer.concat([Buffer.from('v2-'), originalBytes]);

    testEnv.actAs(owner);
    await new FileStorage().updateFileData(file.id, newBytes.toString('base64'));

    expect((await rowAsSystem(file.id))!.copyForOthers?._id ?? null).toBeNull();
    expect(await rowAsSystem(staleCopyId)).toBeUndefined();
    expect(driver.store.has(staleCopyId)).toBe(false);
    const served = await bytesAs(recipient, file.id);
    expect(served.equals(copyOf(newBytes))).toBe(true);
    expect(makerCalls).toHaveLength(2);
    expect(makerCalls[1].bytes.equals(newBytes)).toBe(true);
  });

  it("DELETING THE ORIGINAL DELETES THE COPY: the copy's row and bytes go with the file", async () => {
    const file = await createOwnerFile('gone.jpg', 'image/jpeg');
    reachableFileIds.add(file.id);
    await bytesAs(recipient, file.id);
    const copyId = (await rowAsSystem(file.id))!.copyForOthers!._id!;

    testEnv.actAs(owner);
    await new FileStorage().deleteFile(file.id);

    expect(await rowAsSystem(file.id)).toBeUndefined();
    expect(await rowAsSystem(copyId)).toBeUndefined();
    expect(driver.store.has(file.id)).toBe(false);
    expect(driver.store.has(copyId)).toBe(false);
  });
});

describe('the copy for others — the route, both serving shapes', () => {
  it("proxy shape: a recipient's GET /file/:id serves the copy's bytes under the ORIGINAL's name and type; the owner's serves the original", async () => {
    const driver = new ProxyDriver();
    testEnv.setDriver(driver);
    const file = await createOwnerFile('route-shot.jpg', 'image/jpeg');
    reachableFileIds.add(file.id);

    testEnv.actAs(recipient);
    const theirs = await invokeRoute(file.id);
    testEnv.actAs(owner);
    const mine = await invokeRoute(file.id);

    expect(theirs.statusCode ?? 200).toEqual(200);
    expect(theirs.headers['content-type']).toEqual('image/jpeg');
    expect(theirs.headers['content-disposition']).toEqual('inline; filename="route-shot.jpg"');
    expect((theirs.body as Buffer).equals(copyOf(originalBytes))).toBe(true);
    expect((mine.body as Buffer).equals(originalBytes)).toBe(true);
  });

  it("signed-URL shape (the production store): a recipient is redirected to the COPY's object, the owner to the original's", async () => {
    const driver = new SignedUrlDriver();
    testEnv.setDriver(driver);
    const file = await createOwnerFile('route-clip-poster.jpg', 'image/jpeg');
    reachableFileIds.add(file.id);

    testEnv.actAs(recipient);
    const theirs = await invokeRoute(file.id);
    const copyId = (await rowAsSystem(file.id))!.copyForOthers!._id!;
    testEnv.actAs(owner);
    const mine = await invokeRoute(file.id);

    expect(theirs.statusCode).toEqual(302);
    expect(theirs.redirectUrl).toEqual(`https://signed.test/blob/${copyId}?sig=test`);
    expect(copyId).not.toEqual(file.id);
    expect(mine.statusCode).toEqual(302);
    expect(mine.redirectUrl).toEqual(`https://signed.test/blob/${file.id}?sig=test`);
  });

  it("a file no copy can be made of: a recipient's GET /file/:id is a quiet 403 — not a 500, no error printed; the owner's still serves", async () => {
    const driver = new SignedUrlDriver();
    testEnv.setDriver(driver);
    const file = await createOwnerFile('unrewritable-route.jpg', 'image/jpeg');
    reachableFileIds.add(file.id);
    makerFails = true;
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      testEnv.actAs(recipient);
      const theirs = await invokeRoute(file.id);
      testEnv.actAs(owner);
      const mine = await invokeRoute(file.id);

      expect(theirs.statusCode).toEqual(403);
      expect(theirs.redirectUrl).toBeUndefined();
      expect(consoleError).not.toHaveBeenCalled();
      expect(mine.statusCode).toEqual(302);
      expect(mine.redirectUrl).toEqual(`https://signed.test/blob/${file.id}?sig=test`);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a signed URL for a file the maker does not apply to still names the original's object", async () => {
    const driver = new SignedUrlDriver();
    testEnv.setDriver(driver);
    const file = await createOwnerFile('route-notes.pdf', 'application/pdf');
    reachableFileIds.add(file.id);

    testEnv.actAs(recipient);
    const theirs = await invokeRoute(file.id);

    expect(theirs.redirectUrl).toEqual(`https://signed.test/blob/${file.id}?sig=test`);
  });
});

describe('the copy for others — a server-side door that made its own access decision', () => {
  const driver = new ProxyDriver();
  /** What such a door does: reads the row as system (its own rule opened it), then asks which bytes this caller is served. */
  const throughTheDoor = async (user: User, fileId: string): Promise<Buffer> => {
    const row = (await rowAsSystem(fileId))!;
    testEnv.actAs(user);
    return Buffer.from(await new FileStorage().getAuthorizedFileData(row), 'base64');
  };

  beforeAll(() => {
    testEnv.setDriver(driver);
  });

  it("a caller neither scope nor a resolver opens, whom the door vouches for, is served the maker's copy — the same copy the row names for every other non-owner", async () => {
    const file = await createOwnerFile('attached.jpg', 'image/jpeg');

    const served = await throughTheDoor(recipient, file.id);

    expect(served.includes(LOCATION_MARKER)).toBe(false);
    expect(served.equals(copyOf(originalBytes))).toBe(true);
    const copyId = (await rowAsSystem(file.id))!.copyForOthers?._id;
    expect(copyId).toBeTruthy();
    expect(driver.store.get(copyId!)!.equals(served)).toBe(true);
    // A share recipient later reaching the same file is served that same copy, never a second one.
    reachableFileIds.add(file.id);
    expect((await bytesAs(recipient, file.id)).equals(served)).toBe(true);
    expect(makerCalls.map((call) => call.fileId)).toEqual([file.id]);
  });

  it('the owner through the same door is served the original, byte for byte, and no copy is made', async () => {
    const file = await createOwnerFile('own-attachment.jpg', 'image/jpeg');

    const served = await throughTheDoor(owner, file.id);

    expect(served.equals(originalBytes)).toBe(true);
    expect(makerCalls).toEqual([]);
    expect((await rowAsSystem(file.id))!.copyForOthers?._id ?? null).toBeNull();
  });

  it("when no copy can be made, the door's caller is refused as UNAVAILABLE — a 404 ServiceRefusal carrying the seam's reason, a refusal and never a failure — and never served the original", async () => {
    const file = await createOwnerFile('raw-attachment.jpg', 'image/jpeg');
    makerFails = true;

    const refusal = await throughTheDoor(recipient, file.id).then(
      () => undefined,
      (error: unknown) => error
    );

    // The status the service router answers with and the executor logs at WARN: 404 leaks nothing
    // about the file's existence to a caller who may not read it.
    expect(ServiceRefusal.is(refusal)).toBe(true);
    expect((refusal as ServiceRefusal).status).toBe(404);
    expect((refusal as ServiceRefusal).message).toEqual(
      `File ${file.id} is not available to anyone but its owner: no copy can be made of this file`
    );
    expect((await rowAsSystem(file.id))!.copyForOthers?._id ?? null).toBeNull();
  });
});
