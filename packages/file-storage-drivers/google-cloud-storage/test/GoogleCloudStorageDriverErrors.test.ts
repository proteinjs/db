import http from 'http';
import util from 'util';
import { AddressInfo } from 'net';
import { OAuth2Client } from 'google-auth-library';
import { FileStorageError } from '@proteinjs/db-file';
import { GoogleCloudStorageDriver } from '../src/GoogleCloudStorageDriver';

/** An obviously fake access token — what the storage client sends as `Authorization: Bearer …`. */
const MARKER = 'FAKE-TOKEN-MARKER';

type DriverInternals = { storage: unknown };

/** Every way an application reads an error it caught: printed, serialised, inspected to any depth. */
function everyReadingOf(error: unknown): string {
  return [
    String(error),
    (error as Error)?.stack ?? '',
    JSON.stringify(error),
    JSON.stringify({ error }),
    util.inspect(error),
    util.inspect(error, { depth: null, showHidden: true, getters: true }),
  ].join('\n');
}

/** What the operation threw — anything at all; the assertions decide what it is allowed to be. */
async function failureOf(run: () => Promise<unknown>): Promise<FileStorageError> {
  return await run().then(
    () => {
      throw new Error('expected the operation to fail');
    },
    (error) => error
  );
}

function expectDriverOwned(error: unknown) {
  expect(everyReadingOf(error)).not.toContain(MARKER);
  expect(FileStorageError.is(error)).toBe(true);
  expect(
    Object.getOwnPropertyNames(error)
      .filter((name) => name !== 'status')
      .sort()
  ).toEqual(['code', 'message', 'name', 'stack']);
}

/**
 * THE REAL STORAGE CLIENT against a stub server on the loopback interface (nothing leaves the
 * machine), authorised by a client whose token is the fake marker. The client's own error holds
 * the request it made — headers included — so the marker is inside it; an application that logs
 * the error it caught with a deep inspect (a development log writer does) writes the token out.
 * What leaves the driver is the driver's own error.
 */
describe('GoogleCloudStorageDriver errors, through the real storage client', () => {
  let server: http.Server;
  let driver: GoogleCloudStorageDriver;
  let answerWith = 404;
  let authorizedRequests = 0;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.headers.authorization === `Bearer ${MARKER}`) {
        authorizedRequests++;
      }
      request.resume();
      request.on('end', () => {
        response.writeHead(answerWith, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: answerWith, message: `the store answered ${answerWith}` } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const tokenHolder = new OAuth2Client();
    tokenHolder.setCredentials({ access_token: MARKER, expiry_date: Date.now() + 60 * 60 * 1000 });
    driver = new GoogleCloudStorageDriver({
      projectId: 'test-project',
      bucketName: 'test-bucket',
      storageOptions: {
        apiEndpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        useAuthWithCustomEndpoint: true,
        authClient: tokenHolder,
        retryOptions: { autoRetry: false },
      },
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    answerWith = 404;
    authorizedRequests = 0;
  });

  const picture = { id: 'file-1', name: 'holiday.jpg', type: 'image/jpeg', size: 5 } as never;
  const operations: [string, () => Promise<unknown>][] = [
    ['getFileData', () => driver.getFileData('file-1')],
    ['updateFileData', () => driver.updateFileData('file-1', Buffer.from('bytes').toString('base64'))],
    ['updateFile', () => driver.updateFile(picture)],
  ];

  it.each(operations)('%s on a missing object: not-found, and the token is nowhere in the error', async (name, run) => {
    const failure = await failureOf(run);

    expect(authorizedRequests).toBeGreaterThan(0); // the token WAS on the request that failed
    expectDriverOwned(failure);
    expect(failure.code).toEqual('not-found');
    expect(failure.status).toEqual(404);
    expect(failure.message).toContain(`${name} failed for file file-1: not-found (HTTP 404)`);
  });

  it('createFile refused by the store (the upload path, its own client error): the driver’s error', async () => {
    answerWith = 403;

    const failure = await failureOf(() => driver.createFile(picture, Buffer.from('bytes').toString('base64')));

    expectDriverOwned(failure);
    expect(failure.code).toEqual('forbidden');
    expect(failure.status).toEqual(403);
    expect(failure.message).toContain('createFile failed for file file-1: forbidden (HTTP 403)');
  });

  it('deleteFile refused by the store: forbidden, and the token is nowhere in the error', async () => {
    answerWith = 403;

    const failure = await failureOf(() => driver.deleteFile('file-1'));

    expect(authorizedRequests).toBeGreaterThan(0);
    expectDriverOwned(failure);
    expect(failure.code).toEqual('forbidden');
  });

  it('deleteFile on a missing object is still success — deletes are idempotent', async () => {
    await expect(driver.deleteFile('file-1')).resolves.toBeUndefined();
  });

  it.each([
    [401, 'forbidden'],
    [403, 'forbidden'],
    [412, 'precondition-failed'],
    [429, 'unavailable'],
    [503, 'unavailable'],
    [400, 'unknown'],
  ])('the store answering %i reads as %s', async (status, code) => {
    answerWith = status;

    const failure = await failureOf(() => driver.getFileData('file-1'));

    expectDriverOwned(failure);
    expect(failure.code).toEqual(code);
    expect(failure.status).toEqual(status);
  });

  it('a store that cannot be reached reads as unavailable', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const unreachable = new GoogleCloudStorageDriver({
      projectId: 'test-project',
      bucketName: 'test-bucket',
      storageOptions: { apiEndpoint: `http://127.0.0.1:${port}`, retryOptions: { autoRetry: false } },
    });

    const failure = await failureOf(() => unreachable.getFileData('file-1'));

    expectDriverOwned(failure);
    expect(failure.code).toEqual('unavailable');
    expect(failure.status).toBeUndefined();
  });

  it('a signing failure is the driver’s error too', async () => {
    const failure = await failureOf(() => driver.getSignedUrl('file-1'));

    expectDriverOwned(failure);
    expect(failure.message).toContain('getSignedUrl failed for file file-1');
  });
});

/**
 * THE WORST CASE, whatever client version is installed: an error that carries the credential
 * everywhere one can — its message (a signed URL), an enumerable request config, the request, the
 * response's config and request, its error list, its cause. None of it leaves the driver.
 */
describe('GoogleCloudStorageDriver errors, whatever the client’s error carries', () => {
  const authorization = { Authorization: `Bearer ${MARKER}` };
  const signedUrl = `https://storage.example/test-bucket/file-1?X-Goog-Signature=${MARKER}&X-Goog-Expires=900`;
  const clientError = () =>
    Object.assign(new Error(`Request to ${signedUrl} failed with Authorization: Bearer ${MARKER}`), {
      code: 404,
      config: { url: signedUrl, headers: authorization },
      request: { headers: authorization },
      response: { status: 404, config: { headers: authorization }, request: { headers: authorization } },
      errors: [{ message: `denied for ${signedUrl}` }],
      cause: { config: { headers: authorization } },
    });

  function driverWhoseClientThrows(): GoogleCloudStorageDriver {
    const failing = async () => {
      throw clientError();
    };
    const driver = new GoogleCloudStorageDriver({ projectId: 'test-project', bucketName: 'test-bucket' });
    (driver as unknown as DriverInternals).storage = {
      bucket: () => ({
        file: () => ({
          save: failing,
          download: failing,
          getMetadata: failing,
          setMetadata: failing,
          getSignedUrl: failing,
          delete: failing,
        }),
      }),
    };
    return driver;
  }

  const picture = { id: 'file-1', name: 'holiday.jpg', type: 'image/jpeg', size: 5 } as never;
  const operations: [string, (driver: GoogleCloudStorageDriver) => Promise<unknown>][] = [
    ['createFile', (driver) => driver.createFile(picture, '')],
    ['getFileData', (driver) => driver.getFileData('file-1')],
    ['updateFileData', (driver) => driver.updateFileData('file-1', '')],
    ['updateFile', (driver) => driver.updateFile(picture)],
    ['getSignedUrl', (driver) => driver.getSignedUrl('file-1')],
    ['deleteFile', (driver) => driver.deleteFile('file-1')],
  ];

  it('the stand-in error really does carry the marker everywhere', () => {
    expect(String(clientError())).toContain(MARKER);
    expect(JSON.stringify(clientError())).toContain(MARKER);
    expect(util.inspect(clientError())).toContain(MARKER);
  });

  it.each(operations)(
    '%s: a caller printing, serialising or inspecting the error never reads the marker',
    async (name, run) => {
      const failure = await failureOf(() => run(driverWhoseClientThrows()));

      expectDriverOwned(failure);
      expect(failure.code).toEqual('not-found');
      expect(failure.message).toContain(`${name} failed for file file-1: not-found (HTTP 404)`);
      expect(failure.message).toContain('https://storage.example/test-bucket/file-1 failed');
    }
  );
});
