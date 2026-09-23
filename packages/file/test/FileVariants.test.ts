import { getDbAsSystem, QueryBuilderFactory } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { UserAuth, UserRepo, User, guestUser } from '@proteinjs/user';
import { File } from '../src/tables/FileTable';
import { tables } from '../src/tables/tables';
import { FileStorage } from '../src/FileStorage';
import { FileStorageDriver } from '../src/FileStorageDriver';
import { FileVariantKind } from '../src/FileVariantMaker';
import { getFile } from '../src/routes/getFile';
import { getFileVariant } from '../src/routes/getFileVariant';
import { getFileVariantRoute } from '../src/routes/getFileVariantRoute';
import { FileTestEnvironment } from './FileTestEnvironment';

/**
 * A derived File of a File — the preview and the stage variant — has ONE lifecycle, the library's:
 * made by the registered maker (at ingest with the bytes in hand, or once on the first request from
 * a surface that draws it), stored as the owner's own File naming its original, named on the
 * original's row, dropped when the original's bytes change, deleted with the original, readable by
 * whoever can read the original, and served like any File — through the same non-owner copy rule.
 * This suite proves the seam contract with a stub maker (the real one — a picture's 512 px thumbnail
 * and its 1600 px rendition — lives in the package that knows pictures).
 *
 * The stub maker marks what it makes: `PREVIEW:`/`STAGE:` and the first bytes of the original.
 */

const originalBytes = Buffer.concat([Buffer.from('ORIGINAL:'), Buffer.from(Array.from({ length: 64 }, (_, i) => i))]);
const variantOf = (kind: FileVariantKind, bytes: Buffer): Buffer =>
  Buffer.concat([Buffer.from(`${kind.toUpperCase()}:`), bytes.subarray(0, 8)]);
const VARIANT_EDGE: Record<FileVariantKind, number> = { preview: 512, stage: 1600 };
/** What the copy-for-others maker takes off a copy (the location marker of the real one). */
const COPY_MARK = Buffer.from('-FOR-OTHERS');

/** In-memory proxy-shape driver (no signed URLs) — the DbFileStorageDriver serving shape. */
class ProxyDriver implements FileStorageDriver {
  readonly store = new Map<string, Buffer>();

  async createFile(file: File, fileData: string): Promise<void> {
    this.store.set(file.id, Buffer.from(fileData, 'base64'));
    await atBarrier(); // the racing case: every variant's bytes are stored before any row is asked its word
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

class ResponseRecorder {
  statusCode?: number;
  body?: unknown;
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

  redirect(): void {
    throw new Error('the proxy driver never redirects');
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

/** `GET /file/:id/variant/:kind` — the URL a surface asks for a file's variant by (a plain `<img src>`). */
const invokeVariantRoute = async (fileId: string, kind: string): Promise<ResponseRecorder> => {
  const response = new ResponseRecorder();
  await getFileVariant.onRequest(
    { params: { id: fileId, kind }, headers: {} } as unknown as RouteRequest,
    response as unknown as RouteResponse
  );
  return response;
};

const testEnv = new FileTestEnvironment();
type UserAuthInternals = { userRepo?: unknown };
type SourceRepositoryInternals = { objectCache: Record<string, unknown[]> };
const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;

let owner: User;
let recipient: User;
let stranger: User;
const reachableFileIds = new Set<string>();
/** Every call the variant maker took: which file, which kind, the bytes it was handed. */
let makerCalls: Array<{ fileId: string; kind: FileVariantKind; bytes: Buffer }> = [];
/** The kinds the stub maker applies to (of a picture) — the suite's own rule. */
let kindsApplied: Set<FileVariantKind> = new Set<FileVariantKind>(['preview', 'stage']);
/** A barrier for the racing case — `makerBarrier = n` holds every maker call until n are inside, then releases them on one tick. */
let makerBarrier = 0;
let makerWaiting: Array<() => void> = [];
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

const registerVariantMaker = () => {
  objectCache()['@proteinjs/db-file/FileVariantMaker'] = [
    {
      appliesTo: (file: File, kind: FileVariantKind) => file.type.startsWith('image/') && kindsApplied.has(kind),
      make: async (file: File, bytes: Buffer, kind: FileVariantKind) => {
        makerCalls.push({ fileId: file.id, kind, bytes: Buffer.from(bytes) });
        await atBarrier();
        return {
          bytes: variantOf(kind, bytes),
          type: 'image/webp',
          width: VARIANT_EDGE[kind],
          height: VARIANT_EDGE[kind] / 2,
        };
      },
    },
  ];
};

/** The copy-for-others maker of the copy suite, in miniature: a picture's copy is its bytes with the mark taken off. */
let copyMakerCalls: string[] = [];
const registerCopyMaker = () => {
  objectCache()['@proteinjs/db-file/FileCopyForOthers'] = [
    {
      appliesTo: (file: File) => file.type.startsWith('image/'),
      make: async (file: File, bytes: Buffer) => {
        copyMakerCalls.push(file.id);
        return bytes.subarray(0, bytes.length - COPY_MARK.length);
      },
    },
  ];
};

beforeAll(async () => {
  await testEnv.beforeAll();
  objectCache()['@proteinjs/user-auth/AuthenticatedUserRepo'] = [new UserRepo()];
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  objectCache()['@proteinjs/db-file/FileReachabilityResolver'] = [
    // The content leg vouches for the RECIPIENT alone (a share they accepted); a stranger holds no grant.
    {
      canReadViaReference: async (fileId: string) =>
        reachableFileIds.has(fileId) && new UserRepo().getUser().id === recipient.id,
    },
  ];
  owner = await testEnv.createUser({ name: 'File owner', email: 'variant-owner@test.local' });
  recipient = await testEnv.createUser({ name: 'Share recipient', email: 'variant-recipient@test.local' });
  stranger = await testEnv.createUser({ name: 'Stranger', email: 'variant-stranger@test.local' });
  testEnv.actAs(owner);
});

afterAll(async () => {
  delete objectCache()['@proteinjs/db-file/FileReachabilityResolver'];
  delete objectCache()['@proteinjs/db-file/FileVariantMaker'];
  delete objectCache()['@proteinjs/db-file/FileCopyForOthers'];
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  await testEnv.afterAll();
});

const driver = new ProxyDriver();

beforeEach(() => {
  reachableFileIds.clear();
  makerCalls = [];
  copyMakerCalls = [];
  kindsApplied = new Set<FileVariantKind>(['preview', 'stage']);
  makerBarrier = 0;
  makerWaiting = [];
  registerVariantMaker();
  objectCache()['@proteinjs/db-file/FileCopyForOthers'] = [];
  testEnv.setDriver(driver);
  testEnv.actAs(owner);
});

/** A picture of the owner's, stored with no variant (a file made before the seam, or by a producer that did not derive one). */
const createOwnerPicture = async (name = 'photo.jpg', type = 'image/jpeg', bytes = originalBytes): Promise<File> =>
  await new FileStorage().createFile(
    { name, type, size: bytes.length, width: 4032, height: 3024 } as File,
    bytes.toString('base64')
  );

const rowAsSystem = async (fileId: string): Promise<File | undefined> =>
  await getDbAsSystem().get(tables.File, { id: fileId });

const fileRowsInScope = async (scope: string): Promise<File[]> =>
  await getDbAsSystem().query(
    tables.File,
    new QueryBuilderFactory().getQueryBuilder(tables.File).condition({ field: 'scope', operator: '=', value: scope })
  );

describe('the ingest door — deriveVariants with the bytes in hand', () => {
  it("makes every kind the maker applies to, beside each other: two Files of the OWNER's, each naming its original, each named on the row", async () => {
    const file = await createOwnerPicture('camera.jpg');

    const derived = await new FileStorage().deriveVariants(file, originalBytes);

    expect(makerCalls.map((call) => [call.fileId, call.kind])).toEqual([
      [file.id, 'preview'],
      [file.id, 'stage'],
    ]);
    expect(makerCalls.every((call) => call.bytes.equals(originalBytes))).toBe(true);
    const row = (await rowAsSystem(file.id))!;
    expect(row.preview?._id).toEqual(derived.variants.preview!.id);
    expect(row.stage?._id).toEqual(derived.variants.stage!.id);
    expect(derived.file.preview?._id).toEqual(row.preview?._id);
    expect(derived.file.stage?._id).toEqual(row.stage?._id);
    for (const kind of ['preview', 'stage'] as const) {
      const variant = (await rowAsSystem(derived.variants[kind]!.id))!;
      expect(variant.scope).toEqual(owner.id);
      expect(variant.variantOf?._id).toEqual(file.id);
      expect([variant.name, variant.type, variant.size, variant.width, variant.height]).toEqual([
        `(${kind}) camera.jpg`,
        'image/webp',
        variantOf(kind, originalBytes).length,
        VARIANT_EDGE[kind],
        VARIANT_EDGE[kind] / 2,
      ]);
      expect(driver.store.get(variant.id)!.equals(variantOf(kind, originalBytes))).toBe(true);
    }
    // The original is untouched: its bytes, its size, its own seat empty.
    expect(driver.store.get(file.id)!.equals(originalBytes)).toBe(true);
    expect(row.variantOf?._id ?? null).toBeNull();
  });

  it('a kind the maker does not apply to is not made and its seat stays empty; a kind already named is not made again; with no maker nothing is made', async () => {
    kindsApplied = new Set<FileVariantKind>(['preview']);
    const file = await createOwnerPicture('small.png', 'image/png');

    const first = await new FileStorage().deriveVariants(file, originalBytes);
    expect(Object.keys(first.variants)).toEqual(['preview']);
    expect((await rowAsSystem(file.id))!.stage?._id ?? null).toBeNull();

    kindsApplied = new Set<FileVariantKind>(['preview', 'stage']);
    makerCalls = [];
    const second = await new FileStorage().deriveVariants(first.file, originalBytes);
    expect(makerCalls.map((call) => call.kind)).toEqual(['stage']);
    expect(second.file.preview?._id).toEqual(first.variants.preview!.id);
    expect(second.file.stage?._id).toEqual(second.variants.stage!.id);

    objectCache()['@proteinjs/db-file/FileVariantMaker'] = [];
    const bare = await createOwnerPicture('bare.jpg');
    const none = await new FileStorage().deriveVariants(bare, originalBytes);
    expect(none.variants).toEqual({});
    expect((await rowAsSystem(bare.id))!.stage?._id ?? null).toBeNull();
  });
});

describe('the lifecycle — the stage dies with its original and with its bytes, exactly as the preview does', () => {
  it('deleting the original deletes the stage variant: its row and its bytes (the cascade)', async () => {
    const file = await createOwnerPicture('gone.jpg');
    const { variants } = await new FileStorage().deriveVariants(file, originalBytes);
    expect(driver.store.has(variants.stage!.id)).toBe(true);

    await new FileStorage().deleteFile(file.id);

    expect(await rowAsSystem(variants.stage!.id)).toBeUndefined();
    expect(driver.store.has(variants.stage!.id)).toBe(false);
    expect(await rowAsSystem(variants.preview!.id)).toBeUndefined();
    expect(driver.store.has(variants.preview!.id)).toBe(false);
  });

  it('new bytes drop every derived File — the preview, the stage and the copy for others: the row forgets them, their rows and bytes go', async () => {
    registerCopyMaker();
    const file = await createOwnerPicture('rewritten.jpg');
    const { variants } = await new FileStorage().deriveVariants(file, originalBytes);
    reachableFileIds.add(file.id);
    testEnv.actAs(recipient);
    await new FileStorage().getFileData(file.id); // the copy for others is made and named
    const before = (await rowAsSystem(file.id))!;
    expect(before.copyForOthers?._id).toBeTruthy();

    testEnv.actAs(owner);
    const newBytes = Buffer.from('NEW-BYTES');
    await new FileStorage().updateFileData(file.id, newBytes.toString('base64'));

    const after = (await rowAsSystem(file.id))!;
    expect([after.preview?._id ?? null, after.stage?._id ?? null, after.copyForOthers?._id ?? null]).toEqual([
      null,
      null,
      null,
    ]);
    for (const id of [variants.preview!.id, variants.stage!.id, before.copyForOthers!._id!]) {
      expect(await rowAsSystem(id)).toBeUndefined();
      expect(driver.store.has(id)).toBe(false);
    }
    expect(driver.store.get(file.id)!.equals(newBytes)).toBe(true);
    // The next request derives a fresh stage from the new bytes.
    const fresh = (await new FileStorage().getVariant(file.id, 'stage'))!;
    expect(driver.store.get(fresh.id)!.equals(variantOf('stage', newBytes))).toBe(true);
  });
});

describe('the read path — a File without a stage derives it on the first request, once', () => {
  it('the first getVariant makes the stage and names it; the second is served the same row without the maker', async () => {
    const file = await createOwnerPicture('existing.jpg');
    expect((await rowAsSystem(file.id))!.stage?._id ?? null).toBeNull();

    const first = (await new FileStorage().getVariant(file.id, 'stage'))!;
    const second = (await new FileStorage().getVariant(file.id, 'stage'))!;

    expect(makerCalls.map((call) => call.kind)).toEqual(['stage']);
    expect(makerCalls[0].bytes.equals(originalBytes)).toBe(true);
    expect(second.id).toEqual(first.id);
    expect((await rowAsSystem(file.id))!.stage?._id).toEqual(first.id);
    expect(first.variantOf?._id).toEqual(file.id);
    expect([first.type, first.width, first.height]).toEqual(['image/webp', 1600, 800]);
    expect(driver.store.get(first.id)!.equals(variantOf('stage', originalBytes))).toBe(true);
    // Only the kind asked for: the preview seat stays empty.
    expect((await rowAsSystem(file.id))!.preview?._id ?? null).toBeNull();
  });

  it("a recipient's read derives it as the OWNER's File; the owner is then served the same row", async () => {
    const file = await createOwnerPicture('shared.jpg');
    reachableFileIds.add(file.id);

    testEnv.actAs(recipient);
    const theirs = (await new FileStorage().getVariant(file.id, 'stage'))!;
    testEnv.actAs(owner);
    const mine = (await new FileStorage().getVariant(file.id, 'stage'))!;

    expect(theirs.scope).toEqual(owner.id);
    expect(mine.id).toEqual(theirs.id);
    expect(makerCalls).toHaveLength(1);
    expect((await fileRowsInScope(recipient.id)).map((row) => row.id)).toEqual([]);
  });

  it('a kind the maker does not apply to makes nothing and answers undefined; a caller who cannot read the original gets undefined and nothing is made', async () => {
    const clip = await createOwnerPicture('clip.mp4', 'video/mp4');
    expect(await new FileStorage().getVariant(clip.id, 'stage')).toBeUndefined();
    expect((await rowAsSystem(clip.id))!.stage?._id ?? null).toBeNull();

    const photo = await createOwnerPicture('private.jpg');
    testEnv.actAs(stranger);
    expect(await new FileStorage().getVariant(photo.id, 'stage')).toBeUndefined();
    expect(makerCalls).toEqual([]);
    expect((await rowAsSystem(photo.id))!.stage?._id ?? null).toBeNull();
  });

  it('two readers deriving at once: the row names one stage, the other is deleted with its bytes', async () => {
    const file = await createOwnerPicture('raced.jpg');
    const storedBefore = driver.store.size;
    makerBarrier = 2;

    const [a, b] = await Promise.all([
      new FileStorage().getVariant(file.id, 'stage'),
      new FileStorage().getVariant(file.id, 'stage'),
    ]);

    expect(a!.id).toEqual(b!.id);
    const named = (await rowAsSystem(file.id))!.stage!._id!;
    expect(named).toEqual(a!.id);
    const stagesOfFile = (await fileRowsInScope(owner.id)).filter((row) => row.variantOf?._id === file.id);
    expect(stagesOfFile.map((row) => row.id)).toEqual([named]);
    // One stage's bytes remain of the two made: the loser's row went, and its bytes with it.
    expect(driver.store.size).toEqual(storedBefore + 1);
    expect(driver.store.has(named)).toBe(true);
  });
});

describe('access — a variant is readable by whoever can read its original, and served like any File', () => {
  it('a stage derived after the content was placed is reachable by its own id through its original: the recipient reads it, a stranger cannot', async () => {
    const file = await createOwnerPicture('placed.jpg');
    reachableFileIds.add(file.id); // the content row names the ORIGINAL only — nothing names the stage
    testEnv.actAs(recipient);
    const stage = (await new FileStorage().getVariant(file.id, 'stage'))!;

    expect((await new FileStorage().getFile(stage.id))?.id).toEqual(stage.id);
    expect((await invokeRoute(stage.id)).statusCode).toBeUndefined(); // a plain 200 send: no status set
    expect(Buffer.isBuffer((await invokeRoute(stage.id)).body)).toBe(true);

    testEnv.actAs(stranger);
    expect(await new FileStorage().getFile(stage.id)).toBeUndefined();
    expect((await invokeRoute(stage.id)).statusCode).toEqual(404);

    // Revoked: the moment the original is out of reach, so is its variant.
    reachableFileIds.delete(file.id);
    testEnv.actAs(recipient);
    expect(await new FileStorage().getFile(stage.id)).toBeUndefined();
  });

  it('the non-owner copy rule applies to the stage automatically: a recipient is served the copy of the STAGE, made once and named on the stage row; the owner the stage itself', async () => {
    registerCopyMaker();
    const file = await createOwnerPicture('located.jpg', 'image/jpeg', Buffer.concat([originalBytes, COPY_MARK]));
    reachableFileIds.add(file.id);
    // The stub variant maker keeps the mark on what it makes (the real one keeps a picture's tags for its owner).
    objectCache()['@proteinjs/db-file/FileVariantMaker'] = [
      {
        appliesTo: (candidate: File, kind: FileVariantKind) => candidate.type.startsWith('image/') && kind === 'stage',
        make: async (candidate: File, bytes: Buffer) => ({
          bytes: Buffer.concat([Buffer.from('STAGE:'), bytes.subarray(0, 8), COPY_MARK]),
          type: 'image/webp',
        }),
      },
    ];
    const stage = (await new FileStorage().getVariant(file.id, 'stage'))!;
    const stageBytes = driver.store.get(stage.id)!;
    expect(stageBytes.includes(COPY_MARK)).toBe(true);

    testEnv.actAs(recipient);
    const served = Buffer.from(await new FileStorage().getFileData(stage.id), 'base64');
    const routed = (await invokeRoute(stage.id)).body as Buffer;
    const again = Buffer.from(await new FileStorage().getFileData(stage.id), 'base64');
    testEnv.actAs(owner);
    const ownersOwn = Buffer.from(await new FileStorage().getFileData(stage.id), 'base64');

    expect(served.includes(COPY_MARK)).toBe(false);
    expect(served.equals(stageBytes.subarray(0, stageBytes.length - COPY_MARK.length))).toBe(true);
    expect(routed.equals(served)).toBe(true);
    expect(again.equals(served)).toBe(true);
    expect(copyMakerCalls).toEqual([stage.id]);
    const stageRow = (await rowAsSystem(stage.id))!;
    expect(stageRow.copyForOthers?._id).toBeTruthy();
    const copy = (await rowAsSystem(stageRow.copyForOthers!._id!))!;
    expect(copy.scope).toEqual(owner.id);
    expect(copy.variantOf?._id ?? null).toBeNull(); // the copy's own id stays nobody's but the owner's
    testEnv.actAs(recipient);
    expect(await new FileStorage().getFile(copy.id)).toBeUndefined();
    expect(ownersOwn.equals(stageBytes)).toBe(true);
  });
});

describe('the route — GET /file/:id/variant/:kind is the one URL a surface asks a variant by (an existing row derives on the first request)', () => {
  it('names its path as the file route does', () => {
    expect(getFileVariantRoute.path('abc', 'stage')).toEqual('/file/abc/variant/stage');
    expect(getFileVariant.path).toEqual('/file/:id/variant/:kind');
  });

  it("the first request derives the stage and serves ITS bytes with ITS headers; the second is served the same row without the maker; the original's own route is untouched", async () => {
    const file = await createOwnerPicture('old-row.jpg');

    const first = await invokeVariantRoute(file.id, 'stage');
    const second = await invokeVariantRoute(file.id, 'stage');

    expect(makerCalls.map((call) => call.kind)).toEqual(['stage']);
    const stageId = (await rowAsSystem(file.id))!.stage!._id!;
    for (const served of [first, second]) {
      expect(served.statusCode).toBeUndefined();
      expect((served.body as Buffer).equals(variantOf('stage', originalBytes))).toBe(true);
      expect(served.headers['content-type']).toEqual('image/webp');
      expect(served.headers['content-disposition']).toEqual(
        `inline; filename="${encodeURIComponent(`(stage) old-row.jpg`)}"`
      );
    }
    expect((await rowAsSystem(stageId))!.variantOf?._id).toEqual(file.id);
    const original = await invokeRoute(file.id);
    expect((original.body as Buffer).equals(originalBytes)).toBe(true);
    expect(original.headers['content-type']).toEqual('image/jpeg');
  });

  it('a file the maker does not apply to is served as ITSELF through the variant route (the consumer always gets a picture); nothing is made', async () => {
    const clip = await createOwnerPicture('clip.mp4', 'video/mp4');

    const served = await invokeVariantRoute(clip.id, 'stage');

    expect(served.statusCode).toBeUndefined();
    expect((served.body as Buffer).equals(originalBytes)).toBe(true);
    expect(served.headers['content-type']).toEqual('video/mp4');
    expect(makerCalls).toEqual([]);
    expect((await rowAsSystem(clip.id))!.stage?._id ?? null).toBeNull();
  });

  it('a kind the library does not know, a file the caller cannot read, and no session each answer without a byte', async () => {
    const photo = await createOwnerPicture('private.jpg');
    expect((await invokeVariantRoute(photo.id, 'poster')).statusCode).toEqual(404);
    expect(makerCalls).toEqual([]);

    testEnv.actAs(stranger);
    expect((await invokeVariantRoute(photo.id, 'stage')).statusCode).toEqual(404);
    expect(makerCalls).toEqual([]);
    expect((await rowAsSystem(photo.id))!.stage?._id ?? null).toBeNull();

    testEnv.actAs(guestUser as unknown as User);
    expect((await invokeVariantRoute(photo.id, 'stage')).statusCode).toEqual(401);
  });

  it("a recipient's request through the route derives the stage as the OWNER's File and is served the COPY of it (the non-owner rule, on the route); the owner the stage itself", async () => {
    registerCopyMaker();
    const file = await createOwnerPicture('shared-old.jpg', 'image/jpeg', Buffer.concat([originalBytes, COPY_MARK]));
    reachableFileIds.add(file.id);
    objectCache()['@proteinjs/db-file/FileVariantMaker'] = [
      {
        appliesTo: (candidate: File, kind: FileVariantKind) => candidate.type.startsWith('image/') && kind === 'stage',
        make: async (candidate: File, bytes: Buffer) => ({
          bytes: Buffer.concat([Buffer.from('STAGE:'), bytes.subarray(0, 8), COPY_MARK]),
          type: 'image/webp',
        }),
      },
    ];

    testEnv.actAs(recipient);
    const theirs = await invokeVariantRoute(file.id, 'stage');
    testEnv.actAs(owner);
    const mine = await invokeVariantRoute(file.id, 'stage');

    const stageRow = (await rowAsSystem((await rowAsSystem(file.id))!.stage!._id!))!;
    expect(stageRow.scope).toEqual(owner.id);
    expect((theirs.body as Buffer).includes(COPY_MARK)).toBe(false);
    expect((mine.body as Buffer).includes(COPY_MARK)).toBe(true);
    expect((mine.body as Buffer).equals(driver.store.get(stageRow.id)!)).toBe(true);
    expect(copyMakerCalls).toEqual([stageRow.id]);
    expect((await fileRowsInScope(recipient.id)).map((row) => row.id)).toEqual([]);
  });
});
