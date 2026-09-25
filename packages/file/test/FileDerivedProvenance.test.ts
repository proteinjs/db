import { getDbAsSystem } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { UserAuth, UserRepo, User } from '@proteinjs/user';
import { File, FileTable } from '../src/tables/FileTable';
import { tables } from '../src/tables/tables';
import { FileStorage } from '../src/FileStorage';
import { FileStorageDriver } from '../src/FileStorageDriver';
import { FileVariantKind } from '../src/FileVariantMaker';
import { FileTestEnvironment } from './FileTestEnvironment';

/**
 * A derived File — a variant the seam makes (at ingest with the bytes in hand, or on the read
 * path's first request) and the copy for others — carries its ORIGINAL's provenance: who made the
 * bytes (`origin`, `originModel`), where they came from (`sourceUrl`, `sourcePageUrl`,
 * `retrievedAt`) and the rights that ride with them (`license`, `licenseUrl`, `attribution`) —
 * the columns the table itself names as provenance (`FileTable.provenanceColumns`). A rendition's
 * provenance is its original's: a consumer that labels a thumbnail with what made it, or refuses a
 * non-capture picture as evidence, reads the row it draws, without a join. The library that makes
 * the row writes it, whichever door made the row; a row with no provenance derives rows with none
 * (nothing is invented); a row derived from a derived row carries what that row carries — its
 * original's. The facts of a row's OWN bytes (`size`, `contentHash`, the dimensions) stay the
 * maker's answer, never the original's.
 */

const originalBytes = Buffer.concat([Buffer.from('ORIGINAL:'), Buffer.from(Array.from({ length: 64 }, (_, i) => i))]);
/** What the copy-for-others maker takes off a copy (the location marker of the real one). */
const COPY_MARK = Buffer.from('-FOR-OTHERS');

/**
 * Every provenance column populated at once — whatever the story, each is seen to travel. The
 * fixture is tied to the table's list below: a provenance column added to the table must be added
 * here, and is then proven to travel like the rest.
 */
const PROVENANCE = {
  origin: 'generation',
  originModel: 'vendor/picture-model-1',
  sourceUrl: 'https://source.test/pictures/1.jpg',
  sourcePageUrl: 'https://source.test/pages/1',
  retrievedAt: new Date('2026-09-25T10:00:00.000Z'),
  license: 'CC BY-SA 4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  attribution: 'Photo by Someone, CC BY-SA 4.0',
};

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

const testEnv = new FileTestEnvironment();
type UserAuthInternals = { userRepo?: unknown };
type SourceRepositoryInternals = { objectCache: Record<string, unknown[]> };
const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;

let owner: User;
let recipient: User;
const reachableFileIds = new Set<string>();

/** The stub variant maker: a picture's `preview` and `stage` — bytes marked with the kind, a type, dimensions. Keeps the copy mark on (the real one keeps a picture's tags for its owner). */
const registerVariantMaker = () => {
  objectCache()['@proteinjs/db-file/FileVariantMaker'] = [
    {
      appliesTo: (file: File) => file.type.startsWith('image/'),
      make: async (file: File, bytes: Buffer, kind: FileVariantKind) => ({
        bytes: Buffer.concat([Buffer.from(`${kind.toUpperCase()}:`), bytes.subarray(0, 8), COPY_MARK]),
        type: 'image/webp',
        width: kind === 'stage' ? 1600 : 512,
        height: kind === 'stage' ? 800 : 256,
      }),
    },
  ];
};

/** The stub copy maker: a picture's copy is its bytes with the mark taken off. */
const registerCopyMaker = () => {
  objectCache()['@proteinjs/db-file/FileCopyForOthers'] = [
    {
      appliesTo: (file: File) => file.type.startsWith('image/'),
      make: async (file: File, bytes: Buffer) => bytes.subarray(0, bytes.length - COPY_MARK.length),
    },
  ];
};

beforeAll(async () => {
  await testEnv.beforeAll();
  objectCache()['@proteinjs/user-auth/AuthenticatedUserRepo'] = [new UserRepo()];
  (UserAuth as unknown as UserAuthInternals).userRepo = undefined;
  objectCache()['@proteinjs/db-file/FileReachabilityResolver'] = [
    // The content leg vouches for the recipient alone (a share they accepted).
    {
      canReadViaReference: async (fileId: string) =>
        reachableFileIds.has(fileId) && new UserRepo().getUser().id === recipient.id,
    },
  ];
  owner = await testEnv.createUser({ name: 'File owner', email: 'provenance-owner@test.local' });
  recipient = await testEnv.createUser({ name: 'Share recipient', email: 'provenance-recipient@test.local' });
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
  registerVariantMaker();
  registerCopyMaker();
  testEnv.setDriver(driver);
  testEnv.actAs(owner);
});

/** A picture of the owner's, with (or without) its provenance, stored with no variant. */
const createOwnerPicture = async (name: string, provenance: Partial<File> = {}): Promise<File> =>
  await new FileStorage().createFile(
    {
      name,
      type: 'image/jpeg',
      size: originalBytes.length,
      width: 4032,
      height: 3024,
      contentHash: 'a'.repeat(64),
      ...provenance,
    } as File,
    Buffer.concat([originalBytes, COPY_MARK]).toString('base64')
  );

const rowAsSystem = async (fileId: string): Promise<File> => (await getDbAsSystem().get(tables.File, { id: fileId }))!;

/** The provenance a row carries, column for column as the table names them — `null` for a column it does not hold. */
const provenanceOf = (row: File): Record<string, unknown> =>
  FileTable.provenanceColumns.reduce<Record<string, unknown>>(
    (carried, column) => ({ ...carried, [column]: row[column] ?? null }),
    {}
  );

const NO_PROVENANCE = provenanceOf({} as File);

/** The copy for others of a file, made by a recipient's read of its bytes. */
const copyForOthersOf = async (file: File): Promise<File> => {
  reachableFileIds.add(file.id);
  testEnv.actAs(recipient);
  await new FileStorage().getFileData(file.id);
  testEnv.actAs(owner);
  const copyId = (await rowAsSystem(file.id)).copyForOthers?._id;
  expect(copyId).toBeTruthy();
  return await rowAsSystem(copyId!);
};

describe('the list is the table’s own', () => {
  it('names the producer, the web source and the rights record — and the fixture covers every column it names, so a column added there is proven to travel', () => {
    expect([...FileTable.provenanceColumns].sort()).toEqual(Object.keys(PROVENANCE).sort());
    expect(FileTable.provenanceColumns).toEqual(expect.arrayContaining(['origin', 'originModel']));
    // The facts of a row's own bytes are not provenance.
    expect(FileTable.provenanceColumns).not.toEqual(expect.arrayContaining(['contentHash']));
    expect(FileTable.provenanceColumns).not.toEqual(expect.arrayContaining(['size']));
  });
});

describe('a derived row carries its original’s provenance', () => {
  it("the ingest door: every variant deriveVariants makes carries the original's provenance, column for column; the maker's own answer (bytes, type, dimensions) stays its own", async () => {
    const file = await createOwnerPicture('made.jpg', PROVENANCE);

    const { variants } = await new FileStorage().deriveVariants(file, Buffer.concat([originalBytes, COPY_MARK]));

    expect(Object.keys(variants).sort()).toEqual(['preview', 'stage']);
    for (const kind of ['preview', 'stage'] as const) {
      const variant = await rowAsSystem(variants[kind]!.id);
      expect(provenanceOf(variant)).toEqual(PROVENANCE);
      expect([variant.type, variant.width, variant.height]).toEqual([
        'image/webp',
        kind === 'stage' ? 1600 : 512,
        kind === 'stage' ? 800 : 256,
      ]);
      expect(variant.size).toEqual(driver.store.get(variant.id)!.length);
      // The hash is of THESE bytes, which the maker did not answer: never the original's.
      expect(variant.contentHash ?? null).toBeNull();
    }
  });

  it("the read path's door: the variant getVariant derives on the first request carries the original's provenance", async () => {
    const file = await createOwnerPicture('existing.jpg', PROVENANCE);
    expect((await rowAsSystem(file.id)).stage?._id ?? null).toBeNull();

    const stage = (await new FileStorage().getVariant(file.id, 'stage'))!;

    expect(stage.variantOf?._id).toEqual(file.id);
    expect(provenanceOf(await rowAsSystem(stage.id))).toEqual(PROVENANCE);
  });

  it("the copy for others carries the original's provenance", async () => {
    const file = await createOwnerPicture('shared.jpg', PROVENANCE);

    const copy = await copyForOthersOf(file);

    expect(copy.scope).toEqual(owner.id);
    expect(provenanceOf(copy)).toEqual(PROVENANCE);
    expect(copy.contentHash ?? null).toBeNull();
  });

  it('a row derived from a derived row carries what that row carries — its original’s: the copy for others of a stage variant', async () => {
    const file = await createOwnerPicture('chain.jpg', PROVENANCE);
    const stage = (await new FileStorage().getVariant(file.id, 'stage'))!;
    reachableFileIds.add(file.id); // a variant's reachability is its original's: the grant names the original

    const copyOfStage = await copyForOthersOf(await rowAsSystem(stage.id));

    expect(copyOfStage.variantOf?._id ?? null).toBeNull(); // a copy's own id stays nobody's but the owner's
    expect(provenanceOf(copyOfStage)).toEqual(PROVENANCE);
  });

  it('a row with NO provenance derives rows with none — nothing is invented, at any door', async () => {
    const file = await createOwnerPicture('plain.jpg');
    expect(provenanceOf(await rowAsSystem(file.id))).toEqual(NO_PROVENANCE);

    const { variants } = await new FileStorage().deriveVariants(file, Buffer.concat([originalBytes, COPY_MARK]));
    const copy = await copyForOthersOf(file);

    expect(provenanceOf(await rowAsSystem(variants.preview!.id))).toEqual(NO_PROVENANCE);
    expect(provenanceOf(await rowAsSystem(variants.stage!.id))).toEqual(NO_PROVENANCE);
    expect(provenanceOf(copy)).toEqual(NO_PROVENANCE);
  });
});
