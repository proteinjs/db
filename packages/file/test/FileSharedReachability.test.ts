import { SourceRepository } from '@proteinjs/reflection';
import { UserAuth, UserRepo, User } from '@proteinjs/user';
import { File } from '../src/tables/FileTable';
import { FileStorage } from '../src/FileStorage';
import { FileStorageDriver } from '../src/FileStorageDriver';
import { getFile } from '../src/routes/getFile';
import { FileTestEnvironment } from './FileTestEnvironment';

/** Every byte value once — a payload that corrupts under any text/base64 mix-up. */
const rawBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

/**
 * The shared-content file leg (SHARING_EXPANSION §0 found defect / §1 fix shape): `/file/:id`
 * used the caller's SCOPED row read as its whole access check, so a file embedded in content
 * shared WITH the caller — a shared thought's media — 404'd for every share recipient. The fix
 * is the FileReachabilityResolver seam: after the scoped read misses, content packages answer
 * "can the current user read a row that references this file?" through their own grant-filtered
 * reads, and only then is the row served via system read.
 *
 * This suite proves the SEAM CONTRACT at the route with a stub resolver (content packages sit
 * above db-file — the real thought-media resolver is integration-tested in thought-server):
 * a reachable file serves byte-identical to a non-owner, an unreachable one still 404s (the fix
 * must not over-open), the owner's scoped leg never consults resolvers, and writes stay
 * owner-scoped.
 */

/** In-memory proxy-shape driver (no signed URLs) — the DbFileStorageDriver serving shape. */
class ProxyDriver implements FileStorageDriver {
  readonly store = new Map<string, Buffer>();

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

  async deleteFile(fileId: string): Promise<void> {
    this.store.delete(fileId);
  }
}

/** Proxy driver plus a counting signed-URL mint — the GCS serving shape, minting observable. */
class SignedUrlDriver extends ProxyDriver {
  mintCount = 0;

  async getSignedUrl(fileId: string): Promise<string> {
    this.mintCount++;
    return `https://signed.test/blob/${fileId}?sig=test`;
  }
}

/** Minimal express Response recorder — the route only touches these members. */
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

let owner: User;
let recipient: User;
/** File ids the stub resolver reports as reachable for the current user. */
const reachableFileIds = new Set<string>();
/** How many times the seam was consulted — the owner's scoped leg must never pay for it. */
let resolverConsultations = 0;

beforeAll(async () => {
  await testEnv.beforeAll();
  // The route gates on UserAuth.isLoggedIn(), which resolves its user repo from the source
  // repository — seed it (tests don't load the generated source graph) and reset the static cache.
  objectCache()['@proteinjs/user-auth/AuthenticatedUserRepo'] = [new UserRepo()];
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  // The seam under test, stubbed (the real thought-media resolver lives above this package).
  objectCache()['@proteinjs/db-file/FileReachabilityResolver'] = [
    {
      canReadViaReference: async (fileId: string) => {
        resolverConsultations++;
        return reachableFileIds.has(fileId);
      },
    },
  ];
  owner = await testEnv.createUser({ name: 'File owner', email: 'reachability-owner@test.local' });
  recipient = await testEnv.createUser({ name: 'Share recipient', email: 'reachability-recipient@test.local' });
  testEnv.actAs(owner);
});

afterAll(async () => {
  delete objectCache()['@proteinjs/db-file/FileReachabilityResolver'];
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  await testEnv.afterAll();
});

beforeEach(() => {
  reachableFileIds.clear();
  resolverConsultations = 0;
  testEnv.actAs(owner);
});

const createOwnerFile = async (name: string, type: string): Promise<File> =>
  await new FileStorage().createFile({ name, type, size: rawBytes.length } as File, rawBytes.toString('base64'));

describe('shared-content reachability — proxy serving', () => {
  const driver = new ProxyDriver();

  beforeAll(() => {
    testEnv.setDriver(driver);
  });

  it("THE DEFECT: a non-owner whom a resolver vouches for is served the owner's file byte-identical", async () => {
    const file = await createOwnerFile('shared-shot.png', 'image/png');
    reachableFileIds.add(file.id);

    testEnv.actAs(recipient);
    const response = await invokeRoute(file.id);

    expect(response.statusCode).not.toEqual(404);
    expect(response.headers['content-type']).toEqual('image/png');
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(Buffer.compare(response.body as Buffer, rawBytes)).toBe(0);
  });

  it('THE OTHER DIRECTION: a non-owner with no reachability still 404s — the fix must not over-open', async () => {
    const file = await createOwnerFile('private-shot.png', 'image/png');

    testEnv.actAs(recipient);
    const response = await invokeRoute(file.id);

    expect(response.statusCode).toEqual(404);
    expect(response.body).toEqual('File not found');
  });

  it('the owner is served by their scoped read alone — resolvers are never consulted', async () => {
    const file = await createOwnerFile('own-shot.png', 'image/png');

    const response = await invokeRoute(file.id);

    expect(Buffer.compare(response.body as Buffer, rawBytes)).toBe(0);
    expect(resolverConsultations).toEqual(0);
  });

  it("reachability widens READS only: a vouched-for non-owner's delete leaves the owner's file intact", async () => {
    const file = await createOwnerFile('undeletable.png', 'image/png');
    reachableFileIds.add(file.id);

    testEnv.actAs(recipient);
    await new FileStorage().deleteFile(file.id);

    testEnv.actAs(owner);
    const response = await invokeRoute(file.id);
    expect(Buffer.compare(response.body as Buffer, rawBytes)).toBe(0);
  });
});

describe('shared-content reachability — signed-URL serving', () => {
  const driver = new SignedUrlDriver();

  beforeAll(() => {
    testEnv.setDriver(driver);
  });

  it('302-redirects a vouched-for non-owner to a signed URL (the GCS prod shape)', async () => {
    const file = await createOwnerFile('shared-clip.mp4', 'video/mp4');
    reachableFileIds.add(file.id);

    testEnv.actAs(recipient);
    const response = await invokeRoute(file.id);

    expect(response.statusCode).toEqual(302);
    expect(response.redirectUrl).toEqual(`https://signed.test/blob/${file.id}?sig=test`);
  });

  it('404s an unreachable non-owner WITHOUT minting a signed URL (a signed URL is a bearer capability)', async () => {
    const file = await createOwnerFile('private-clip.mp4', 'video/mp4');
    const mintsBefore = driver.mintCount;

    testEnv.actAs(recipient);
    const response = await invokeRoute(file.id);

    expect(response.statusCode).toEqual(404);
    expect(response.redirectUrl).toBeUndefined();
    expect(driver.mintCount).toEqual(mintsBefore);
  });
});
