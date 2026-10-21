import { SourceRepository } from '@proteinjs/reflection';
import { UserAuth, UserRepo, guestUser, User } from '@proteinjs/user';
import { File } from '../src/tables/FileTable';
import { FileStorage } from '../src/FileStorage';
import { FileStorageDriver } from '../src/FileStorageDriver';
import type { FileVariantKind } from '../src/FileVariantMaker';
import { getFile } from '../src/routes/getFile';
import { getFileBytes } from '../src/routes/getFileBytes';
import { getFileVariantBytes } from '../src/routes/getFileVariantBytes';
import { getFileRoute, getFileBytesRoute } from '../src/routes/getFileRoute';
import { getFileVariantRoute, getFileVariantBytesRoute } from '../src/routes/getFileVariantRoute';
import { FileTestEnvironment } from './FileTestEnvironment';

/** Every byte value once — a payload that corrupts under any text/base64 mix-up. */
const rawBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
/** The copy for others — the original's first eight bytes behind a mark, byte-distinct from it. */
const COPY_MARK = Buffer.from('COPY-FOR-OTHERS');
const copyOf = (bytes: Buffer): Buffer => Buffer.concat([COPY_MARK, bytes.subarray(0, 8)]);
/** A variant — the kind's name over the original's first eight bytes. */
const variantOf = (kind: FileVariantKind, bytes: Buffer): Buffer =>
  Buffer.concat([Buffer.from(`${kind}:`), bytes.subarray(0, 8)]);

/**
 * A driver WITH an external URL space (the signed-URL serving case): `GET /file/:id` answers a 302 into
 * it. The bytes doors must never redirect — they serve the bytes themselves, whatever the driver's URL
 * space; so a signed URL minted by this driver is the proof that the door skipped it.
 */
class TestSignedUrlFileStorageDriver implements FileStorageDriver {
  readonly store = new Map<string, Buffer>();
  signedUrlsMinted = 0;

  async createFile(file: File, fileData: string): Promise<void> {
    this.store.set(file.id, Buffer.from(fileData, 'base64'));
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

  async getSignedUrl(fileId: string): Promise<string> {
    this.signedUrlsMinted++;
    return `https://blobs.example/${fileId}?sig=test`;
  }

  async deleteFile(fileId: string): Promise<void> {
    this.store.delete(fileId);
  }
}

/** Minimal express Response recorder — the routes only touch these members. */
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

type RouteRequest = Parameters<typeof getFileBytes.onRequest>[0];
type RouteResponse = Parameters<typeof getFileBytes.onRequest>[1];

const invokeBytes = async (fileId: string, headers: Record<string, string> = {}): Promise<ResponseRecorder> => {
  const response = new ResponseRecorder();
  await getFileBytes.onRequest(
    { params: { id: fileId }, headers } as unknown as RouteRequest,
    response as unknown as RouteResponse
  );
  return response;
};

const invokeVariantBytes = async (
  fileId: string,
  kind: string,
  headers: Record<string, string> = {}
): Promise<ResponseRecorder> => {
  const response = new ResponseRecorder();
  await getFileVariantBytes.onRequest(
    { params: { id: fileId, kind }, headers } as unknown as RouteRequest,
    response as unknown as RouteResponse
  );
  return response;
};

const invokeFile = async (fileId: string): Promise<ResponseRecorder> => {
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
const driver = new TestSignedUrlFileStorageDriver();
let owner: User;
let recipient: User;
let stranger: User;
/** File ids the stub resolver reports as reachable for the current user (the shared-content leg). */
const reachableFileIds = new Set<string>();

beforeAll(async () => {
  await testEnv.beforeAll();
  // The routes gate on UserAuth.isLoggedIn(), which resolves its user repo from the source repository —
  // seed it (tests don't load the generated source graph) and reset the static cache.
  objectCache()['@proteinjs/user-auth/AuthenticatedUserRepo'] = [new UserRepo()];
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  objectCache()['@proteinjs/db-file/FileReachabilityResolver'] = [
    { canReadViaReference: async (fileId: string) => reachableFileIds.has(fileId) },
  ];
  testEnv.setDriver(driver);
  owner = await testEnv.createUser({ name: 'File owner', email: 'bytes-owner@test.local' });
  recipient = await testEnv.createUser({ name: 'Share recipient', email: 'bytes-recipient@test.local' });
  stranger = await testEnv.createUser({ name: 'Stranger', email: 'bytes-stranger@test.local' });
  testEnv.actAs(owner);
});

afterAll(async () => {
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  delete objectCache()['@proteinjs/db-file/FileReachabilityResolver'];
  await testEnv.afterAll();
});

beforeEach(() => {
  reachableFileIds.clear();
  objectCache()['@proteinjs/db-file/FileCopyForOthers'] = [];
  objectCache()['@proteinjs/db-file/FileVariantMaker'] = [];
  driver.signedUrlsMinted = 0;
  testEnv.actAs(owner);
});

const createOwnerFile = async (name: string, type = 'image/png'): Promise<File> =>
  await new FileStorage().createFile({ name, type, size: rawBytes.length } as File, rawBytes.toString('base64'));

describe('the route paths — the bytes door is the file URL plus /bytes, one rule for both doors', () => {
  it('names the doors from the app URLs the surfaces already use', () => {
    expect(getFileBytesRoute.path('f1')).toEqual(`${getFileRoute.path('f1')}/bytes`);
    expect(getFileVariantBytesRoute.path('f1', 'preview')).toEqual(
      `${getFileVariantRoute.path('f1', 'preview')}/bytes`
    );
    expect(getFileBytes.path).toEqual('/file/:id/bytes');
    expect(getFileVariantBytes.path).toEqual('/file/:id/variant/:kind/bytes');
  });
});

describe('GET /file/:id/bytes — the same-origin bytes door', () => {
  it('serves the true bytes itself and never a redirect, though the driver has a URL space (the proxy branch)', async () => {
    const file = await createOwnerFile('shot.png');

    const asFile = await invokeFile(file.id);
    expect(asFile.statusCode).toEqual(302);

    const response = await invokeBytes(file.id);

    expect(response.redirectUrl).toBeUndefined();
    expect(response.statusCode).not.toEqual(302);
    expect(response.headers['content-type']).toEqual('image/png');
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(Buffer.compare(response.body as Buffer, rawBytes)).toBe(0);
    // The signed URL the file route minted is the only one — the bytes door never asked for one.
    expect(driver.signedUrlsMinted).toEqual(1);
  });

  it('says the browser may keep the bytes privately — never a shared cache (the bytes are per caller)', async () => {
    const file = await createOwnerFile('cached.png');

    const response = await invokeBytes(file.id);

    expect(response.headers['cache-control']).toEqual('private, max-age=300');
    expect(response.headers['cache-control']).not.toContain('public');
  });

  it('honors Range exactly as the proxy branch does (206 with the bytes asked)', async () => {
    const file = await createOwnerFile('clip.webm', 'video/webm');

    const response = await invokeBytes(file.id, { range: 'bytes=10-19' });

    expect(response.statusCode).toEqual(206);
    expect(response.headers['accept-ranges']).toEqual('bytes');
    expect(response.headers['content-range']).toEqual('bytes 10-19/256');
    expect(Buffer.compare(response.body as Buffer, rawBytes.subarray(10, 20))).toBe(0);
  });

  it('serves a shared-content recipient the COPY for others, as every door does — the same egress owner', async () => {
    const file = await createOwnerFile('shared.jpg', 'image/jpeg');
    reachableFileIds.add(file.id);
    objectCache()['@proteinjs/db-file/FileCopyForOthers'] = [
      { appliesTo: () => true, make: async (_file: File, bytes: Buffer) => copyOf(bytes) },
    ];

    testEnv.actAs(recipient);
    const response = await invokeBytes(file.id);

    expect(response.statusCode).not.toEqual(404);
    expect(Buffer.compare(response.body as Buffer, copyOf(rawBytes))).toBe(0);
    expect(Buffer.compare(response.body as Buffer, rawBytes)).not.toBe(0);

    // The owner's own read through the same door is the original.
    testEnv.actAs(owner);
    const own = await invokeBytes(file.id);
    expect(Buffer.compare(own.body as Buffer, rawBytes)).toBe(0);
  });

  it("THE ERROR SURFACE: a stranger holding only the id is answered 404 'File not found' — the row read decides, no new permission", async () => {
    const file = await createOwnerFile('private.png');

    testEnv.actAs(stranger);
    const response = await invokeBytes(file.id);

    expect(response.statusCode).toEqual(404);
    expect(response.body).toEqual('File not found');
    expect(response.redirectUrl).toBeUndefined();
  });

  it('404s on a missing id without touching the driver', async () => {
    const response = await invokeBytes('00000000-0000-0000-0000-000000000000');

    expect(response.statusCode).toEqual(404);
    expect(response.body).toEqual('File not found');
    expect(driver.signedUrlsMinted).toEqual(0);
  });

  it('401s when not logged in', async () => {
    const file = await createOwnerFile('clip.png');
    testEnv.actAs(guestUser as unknown as User);
    try {
      const response = await invokeBytes(file.id);

      expect(response.statusCode).toEqual(401);
      expect(response.body).toBeDefined();
      expect(Buffer.isBuffer(response.body)).toBe(false);
    } finally {
      testEnv.actAs(owner);
    }
  });
});

describe('GET /file/:id/variant/:kind/bytes — the variant through the same door', () => {
  it("serves the variant's bytes itself, never a redirect (the maker's bytes, not the original's)", async () => {
    objectCache()['@proteinjs/db-file/FileVariantMaker'] = [
      {
        appliesTo: (file: File, kind: FileVariantKind) => file.type.startsWith('image/') && kind === 'preview',
        make: async (_file: File, bytes: Buffer, kind: FileVariantKind) => ({
          bytes: variantOf(kind, bytes),
          type: 'image/webp',
          width: 8,
          height: 4,
        }),
      },
    ];
    const file = await createOwnerFile('photo.jpg', 'image/jpeg');

    const response = await invokeVariantBytes(file.id, 'preview');

    expect(response.redirectUrl).toBeUndefined();
    expect(response.headers['content-type']).toEqual('image/webp');
    expect(response.headers['cache-control']).toEqual('private, max-age=300');
    expect(Buffer.compare(response.body as Buffer, variantOf('preview', rawBytes))).toBe(0);
  });

  it('serves the file itself when no variant applies (the consumer never branches)', async () => {
    const file = await createOwnerFile('tiny.png');

    const response = await invokeVariantBytes(file.id, 'preview');

    expect(response.redirectUrl).toBeUndefined();
    expect(Buffer.compare(response.body as Buffer, rawBytes)).toBe(0);
  });

  it('404s a kind the library does not know, as a file that is not there', async () => {
    const file = await createOwnerFile('any.png');

    const response = await invokeVariantBytes(file.id, 'poster');

    expect(response.statusCode).toEqual(404);
    expect(response.body).toEqual('File not found');
  });

  it("THE ERROR SURFACE: a stranger is answered 404 for a variant too — the original's read decides", async () => {
    const file = await createOwnerFile('private.jpg', 'image/jpeg');

    testEnv.actAs(stranger);
    const response = await invokeVariantBytes(file.id, 'preview');

    expect(response.statusCode).toEqual(404);
    expect(response.body).toEqual('File not found');
  });
});
