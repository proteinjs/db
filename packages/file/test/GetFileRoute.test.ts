import * as http from 'http';
import { AddressInfo } from 'net';
import { SourceRepository } from '@proteinjs/reflection';
import { UserAuth, UserRepo, guestUser, User } from '@proteinjs/user';
import { File } from '../src/tables/FileTable';
import { FileStorage } from '../src/FileStorage';
import { FileStorageDriver } from '../src/FileStorageDriver';
import { getFile } from '../src/routes/getFile';
import { FileTestEnvironment } from './FileTestEnvironment';

/** Every byte value once — a payload that corrupts under any text/base64 mix-up. */
const rawBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

/**
 * In-memory byte store shaped like the GoogleCloudStorageDriver WITHOUT signed-URL support:
 * the proxy-serving case (DbFileStorageDriver shape). Stores true bytes at rest per the driver
 * contract; the interface strings are base64.
 */
class TestProxyFileStorageDriver implements FileStorageDriver {
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

/**
 * Local GCS shim: the signed-URL serving case. Blobs live as TRUE bytes behind a real local HTTP
 * server (as they do in GCS); `getSignedUrl` mints a URL into that server's URL space, and
 * clients read the bytes directly from it — exactly the redirect flow the route implements.
 */
class TestSignedUrlFileStorageDriver implements FileStorageDriver {
  readonly store = new Map<string, { bytes: Buffer; contentType: string }>();
  private server?: http.Server;
  private port?: number;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const fileId = (req.url ?? '').replace(/^\/blob\//, '').split('?')[0];
      const blob = this.store.get(fileId);
      if (!blob) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': blob.contentType, 'Content-Length': blob.bytes.length });
      res.end(blob.bytes);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => this.server!.close((err) => (err ? reject(err) : resolve())));
    }
  }

  async createFile(file: File, fileData: string): Promise<void> {
    this.store.set(file.id, { bytes: Buffer.from(fileData, 'base64'), contentType: file.type });
  }

  async getFileData(fileId: string): Promise<string> {
    const blob = this.store.get(fileId);
    if (blob === undefined) {
      throw new Error(`No such object: ${fileId}`);
    }
    return blob.bytes.toString('base64');
  }

  async updateFileData(fileId: string, data: string): Promise<void> {
    const existing = this.store.get(fileId);
    this.store.set(fileId, {
      bytes: Buffer.from(data, 'base64'),
      contentType: existing?.contentType ?? 'application/octet-stream',
    });
  }

  async getSignedUrl(fileId: string, options?: { ttlMs?: number }): Promise<string> {
    const expires = Date.now() + (options?.ttlMs ?? 15 * 60 * 1000);
    return `http://127.0.0.1:${this.port}/blob/${fileId}?sig=test&expires=${expires}`;
  }

  async deleteFile(fileId: string): Promise<void> {
    this.store.delete(fileId);
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

const invokeRoute = async (fileId: string, headers: Record<string, string> = {}): Promise<ResponseRecorder> => {
  const response = new ResponseRecorder();
  await getFile.onRequest(
    { params: { id: fileId }, headers } as unknown as RouteRequest,
    response as unknown as RouteResponse
  );
  return response;
};

const testEnv = new FileTestEnvironment();
type UserAuthInternals = { userRepo?: unknown };
let user: User;

beforeAll(async () => {
  await testEnv.beforeAll();
  // The route gates on UserAuth.isLoggedIn(), which resolves its user repo from the source
  // repository — seed it (tests don't load the generated source graph) and reset the static cache.
  const objectCache = (SourceRepository.get() as unknown as { objectCache: Record<string, unknown[]> }).objectCache;
  objectCache['@proteinjs/user-auth/AuthenticatedUserRepo'] = [new UserRepo()];
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  user = await testEnv.createUser({ name: 'File owner', email: 'file-owner@test.local' });
  testEnv.actAs(user);
});

afterAll(async () => {
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  await testEnv.afterAll();
});

describe('GET /file/:id — proxy serving (driver without signed URLs)', () => {
  const driver = new TestProxyFileStorageDriver();

  beforeAll(() => {
    testEnv.setDriver(driver);
  });

  it('serves a non-image binary byte-identical (video/mp4 round-trip)', async () => {
    const file = await new FileStorage().createFile(
      { name: 'clip.mp4', type: 'video/mp4', size: rawBytes.length } as File,
      rawBytes.toString('base64')
    );

    const response = await invokeRoute(file.id);

    expect(response.redirectUrl).toBeUndefined();
    expect(response.headers['content-type']).toEqual('video/mp4');
    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(Buffer.compare(response.body as Buffer, rawBytes)).toBe(0);
  });

  it('still serves images byte-identical (no regression on the decoded-image path)', async () => {
    const file = await new FileStorage().createFile(
      { name: 'shot.png', type: 'image/png', size: rawBytes.length } as File,
      rawBytes.toString('base64')
    );

    const response = await invokeRoute(file.id);

    expect(Buffer.isBuffer(response.body)).toBe(true);
    expect(Buffer.compare(response.body as Buffer, rawBytes)).toBe(0);
  });

  // ── HTTP Range on the proxy path — video streaming parity with the signed-URL path, so a
  //    <video> can seek against a proxy-served blob instead of downloading it whole. ──────────
  describe('Range requests (video seek parity with the signed-URL path)', () => {
    let videoFileId: string;

    beforeAll(async () => {
      const file = await new FileStorage().createFile(
        { name: 'smoke.webm', type: 'video/webm', size: rawBytes.length } as File,
        rawBytes.toString('base64')
      );
      videoFileId = file.id;
    });

    it('advertises Accept-Ranges and serves the whole file when no Range is asked', async () => {
      const response = await invokeRoute(videoFileId);
      expect(response.headers['accept-ranges']).toEqual('bytes');
      expect(Buffer.compare(response.body as Buffer, rawBytes)).toBe(0);
    });

    it('serves a bounded range as 206 with Content-Range and exactly those bytes', async () => {
      const response = await invokeRoute(videoFileId, { range: 'bytes=10-19' });
      expect(response.statusCode).toEqual(206);
      expect(response.headers['content-range']).toEqual('bytes 10-19/256');
      expect(response.headers['accept-ranges']).toEqual('bytes');
      expect(Buffer.compare(response.body as Buffer, rawBytes.subarray(10, 20))).toBe(0);
    });

    it('serves an open-ended range to EOF (the video-seek shape)', async () => {
      const response = await invokeRoute(videoFileId, { range: 'bytes=200-' });
      expect(response.statusCode).toEqual(206);
      expect(response.headers['content-range']).toEqual('bytes 200-255/256');
      expect(Buffer.compare(response.body as Buffer, rawBytes.subarray(200))).toBe(0);
    });

    it('serves a suffix range (last N bytes)', async () => {
      const response = await invokeRoute(videoFileId, { range: 'bytes=-16' });
      expect(response.statusCode).toEqual(206);
      expect(response.headers['content-range']).toEqual('bytes 240-255/256');
      expect(Buffer.compare(response.body as Buffer, rawBytes.subarray(240))).toBe(0);
    });

    it('clamps an over-long range to the end of the file', async () => {
      const response = await invokeRoute(videoFileId, { range: 'bytes=250-999' });
      expect(response.statusCode).toEqual(206);
      expect(response.headers['content-range']).toEqual('bytes 250-255/256');
      expect(Buffer.compare(response.body as Buffer, rawBytes.subarray(250))).toBe(0);
    });

    it('416s an unsatisfiable range, naming the size', async () => {
      const response = await invokeRoute(videoFileId, { range: 'bytes=999-' });
      expect(response.statusCode).toEqual(416);
      expect(response.headers['content-range']).toEqual('bytes */256');
    });

    it('ignores malformed and multi-range headers — the whole file serves', async () => {
      for (const range of ['bytes=5-2', 'apples=1-2', 'bytes=0-1,3-4', 'bytes=x-y']) {
        const response = await invokeRoute(videoFileId, { range });
        expect(response.statusCode).not.toEqual(206);
        expect(Buffer.compare(response.body as Buffer, rawBytes)).toBe(0);
      }
    });
  });
});

describe('GET /file/:id — signed-URL serving (302 redirect)', () => {
  const driver = new TestSignedUrlFileStorageDriver();

  beforeAll(async () => {
    await driver.start();
    testEnv.setDriver(driver);
  });

  afterAll(async () => {
    await driver.stop();
  });

  it('302-redirects to the signed URL; following it yields the true bytes, byte-identical', async () => {
    const file = await new FileStorage().createFile(
      { name: 'clip.mp4', type: 'video/mp4', size: rawBytes.length } as File,
      rawBytes.toString('base64')
    );

    const response = await invokeRoute(file.id);

    expect(response.statusCode).toEqual(302);
    expect(response.redirectUrl).toBeDefined();

    const blobResponse = await fetch(response.redirectUrl!);
    expect(blobResponse.status).toEqual(200);
    expect(blobResponse.headers.get('content-type')).toEqual('video/mp4');
    const served = Buffer.from(await blobResponse.arrayBuffer());
    expect(Buffer.compare(served, rawBytes)).toBe(0);
  });

  it('caches the redirect briefly so repeated loads reuse one signed URL within its TTL', async () => {
    const file = await new FileStorage().createFile(
      { name: 'shot.png', type: 'image/png', size: rawBytes.length } as File,
      rawBytes.toString('base64')
    );

    const response = await invokeRoute(file.id);

    expect(response.statusCode).toEqual(302);
    expect(response.headers['cache-control']).toEqual('private, max-age=300');
  });

  it('404s on a missing file id without minting a signed URL', async () => {
    const response = await invokeRoute('00000000-0000-0000-0000-000000000000');

    expect(response.statusCode).toEqual(404);
    expect(response.redirectUrl).toBeUndefined();
  });

  it('401s when not logged in, without redirecting or leaking a signed URL', async () => {
    const file = await new FileStorage().createFile(
      { name: 'clip.mp4', type: 'video/mp4', size: rawBytes.length } as File,
      rawBytes.toString('base64')
    );
    testEnv.actAs(guestUser as unknown as User);
    try {
      const response = await invokeRoute(file.id);

      expect(response.statusCode).toEqual(401);
      expect(response.redirectUrl).toBeUndefined();
    } finally {
      testEnv.actAs(user);
    }
  });
});
