import { SourceRepository } from '@proteinjs/reflection';
import { User } from '@proteinjs/user';
import { File } from '../src/tables/FileTable';
import { FileStorage } from '../src/FileStorage';
import { DbFileStorageDriver } from '../src/DbFileStorageDriver';
import { FileTestEnvironment } from './FileTestEnvironment';

/** Every byte value once — a payload that corrupts under any text/base64 mix-up. */
const rawBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const rawBase64 = rawBytes.toString('base64');
/** A same-length replacement payload, byte-distinct at every position — the poisoning attempt. */
const poisonBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => 255 - i));
const poisonBase64 = poisonBytes.toString('base64');

/**
 * The byte-access gates on the browser-facing service (FileStorageService is `allUsers`, so
 * these methods are every logged-in user's to call with any file id they can guess or leak):
 *
 * - **Reads** (`getFileData`): gated on the {@link FileStorage.getFile} row read — the same
 *   two-legged access decision every serving path derives from (the caller's SCOPED read, else
 *   the FileReachabilityResolver shared-content leg). Bytes are exactly as reachable as the row
 *   that names them. Ungated, a foreign file id read another user's bytes outright (the driver
 *   byte ops are deliberately unscoped — the access wall lives at this service boundary).
 * - **Writes** (`updateFileData`): gated on the caller's SCOPED row read — owner scope is the
 *   write grant on ScopedRecords. Stricter than reads: the resolver leg widens READS only, so a
 *   share recipient who can read bytes still cannot write them. Ungated, a foreign file id let
 *   any caller poison another user's bytes (with the DbFileStorageDriver: caller-scoped chunk
 *   inserts landing beside the owner's — this suite runs that real driver so the intact-bytes
 *   assertions prove no chunk ever landed).
 *
 * The resolver is stubbed at the seam (content packages sit above db-file); denial is the named
 * `File not found` — existence is not leaked to unauthorized callers.
 */

const testEnv = new FileTestEnvironment();
type SourceRepositoryInternals = { objectCache: Record<string, unknown[]> };
const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;

let owner: User;
let recipient: User;
let stranger: User;
/** File ids the stub resolver reports as reachable for the current user. */
const reachableFileIds = new Set<string>();
/** How many times the seam was consulted — the owner's scoped leg must never pay for it. */
let resolverConsultations = 0;

beforeAll(async () => {
  await testEnv.beforeAll();
  // The seam getFile consults on a scoped-read miss, stubbed (the real thought-media resolver
  // lives above this package).
  objectCache()['@proteinjs/db-file/FileReachabilityResolver'] = [
    {
      canReadViaReference: async (fileId: string) => {
        resolverConsultations++;
        return reachableFileIds.has(fileId);
      },
    },
  ];
  // The real chunked driver: write-gate bites are proven at the chunk-row level, not a mock.
  testEnv.setDriver(new DbFileStorageDriver());
  owner = await testEnv.createUser({ name: 'File owner', email: 'byte-owner@test.local' });
  recipient = await testEnv.createUser({ name: 'Share recipient', email: 'byte-recipient@test.local' });
  stranger = await testEnv.createUser({ name: 'Stranger', email: 'byte-stranger@test.local' });
  testEnv.actAs(owner);
});

afterAll(async () => {
  delete objectCache()['@proteinjs/db-file/FileReachabilityResolver'];
  await testEnv.afterAll();
});

beforeEach(() => {
  reachableFileIds.clear();
  resolverConsultations = 0;
  testEnv.actAs(owner);
});

const createOwnerFile = async (name: string): Promise<File> =>
  await new FileStorage().createFile(
    { name, type: 'application/octet-stream', size: rawBytes.length } as File,
    rawBase64
  );

describe('byte reads gate on the file-row read (the getFile decision)', () => {
  it('the owner reads their bytes through the scoped leg alone — resolvers are never consulted', async () => {
    const file = await createOwnerFile('own-bytes.bin');

    const fileDataBase64 = await new FileStorage().getFileData(file.id);

    expect(fileDataBase64).toEqual(rawBase64);
    expect(resolverConsultations).toEqual(0);
  });

  it("THE VULN (read): a stranger holding only the file id is DENIED another user's bytes", async () => {
    const file = await createOwnerFile('private-bytes.bin');

    testEnv.actAs(stranger);
    await expect(new FileStorage().getFileData(file.id)).rejects.toThrow(`File not found: ${file.id}`);
  });

  it('a shared-content recipient (resolver-vouched) reads the bytes byte-identical', async () => {
    const file = await createOwnerFile('shared-bytes.bin');
    reachableFileIds.add(file.id);

    testEnv.actAs(recipient);
    const fileDataBase64 = await new FileStorage().getFileData(file.id);

    expect(fileDataBase64).toEqual(rawBase64);
  });
});

describe('byte writes gate on the caller WRITING the row (owner scope; read-reachability never grants it)', () => {
  it("THE VULN (write): a stranger holding only the file id cannot poison another user's bytes", async () => {
    const file = await createOwnerFile('unpoisonable.bin');

    testEnv.actAs(stranger);
    await expect(new FileStorage().updateFileData(file.id, poisonBase64)).rejects.toThrow(`File not found: ${file.id}`);

    // The outcome that matters: no chunk landed — the owner's bytes read back untouched.
    testEnv.actAs(owner);
    expect(await new FileStorage().getFileData(file.id)).toEqual(rawBase64);
  });

  it("read-reachability does NOT grant write: a vouched recipient's byte write is denied, bytes intact", async () => {
    const file = await createOwnerFile('read-only-share.bin');
    reachableFileIds.add(file.id);

    testEnv.actAs(recipient);
    expect(await new FileStorage().getFileData(file.id)).toEqual(rawBase64);
    await expect(new FileStorage().updateFileData(file.id, poisonBase64)).rejects.toThrow(`File not found: ${file.id}`);

    testEnv.actAs(owner);
    expect(await new FileStorage().getFileData(file.id)).toEqual(rawBase64);
  });

  it('the owner replaces their bytes wholesale', async () => {
    const file = await createOwnerFile('rewritable.bin');

    await new FileStorage().updateFileData(file.id, poisonBase64);

    expect(await new FileStorage().getFileData(file.id)).toEqual(poisonBase64);
  });
});
