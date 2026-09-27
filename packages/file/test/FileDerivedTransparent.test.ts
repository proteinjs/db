import { getDbAsSystem } from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { UserAuth, UserRepo, User } from '@proteinjs/user';
import { File } from '../src/tables/FileTable';
import { tables } from '../src/tables/tables';
import { FileStorage } from '../src/FileStorage';
import { FileStorageDriver } from '../src/FileStorageDriver';
import { FileVariantKind } from '../src/FileVariantMaker';
import { FileTestEnvironment } from './FileTestEnvironment';

/**
 * A derived File of a picture — a variant the seam makes (the preview at ingest, the stage on the
 * read path's first request) and the copy for others — is a RENDITION of the picture's pixels, so
 * it carries what the picture's pixels are: whether they are see-through (`transparent`). A
 * thumbnail of a mark made on a transparent background is see-through (the maker resizes, it does
 * not flatten); a photograph's thumbnail is opaque, as the photograph is; a picture nothing probed
 * derives renditions with no answer — nothing is invented. The library that makes the row writes
 * it, beside the provenance it carries the same way (`FileTable.renditionColumns` beside
 * `FileTable.provenanceColumns`), so a consumer seats a rendition on the surface its picture sat
 * on by reading the row it draws, without a join to the original. The maker's own answer (the
 * bytes, their type, their dimensions) stays the rendition's own.
 */

const originalBytes = Buffer.concat([Buffer.from('ORIGINAL:'), Buffer.from(Array.from({ length: 64 }, (_, i) => i))]);
/** What the copy-for-others maker takes off a copy (the location marker of the real one). */
const COPY_MARK = Buffer.from('-FOR-OTHERS');

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

/** The stub variant maker: a picture's `preview` and `stage` — bytes marked with the kind, a type, dimensions; it answers nothing about the pixels' alpha. */
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
  owner = await testEnv.createUser({ name: 'File owner', email: 'transparent-owner@test.local' });
  recipient = await testEnv.createUser({ name: 'Share recipient', email: 'transparent-recipient@test.local' });
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

const pictureBytes = Buffer.concat([originalBytes, COPY_MARK]);

/** A picture of the owner's — with the answer ingest read off its pixels, or without one — stored with no variant. */
const createOwnerPicture = async (name: string, pixels: Pick<File, 'transparent'> = {}): Promise<File> =>
  await new FileStorage().createFile(
    { name, type: 'image/png', size: pictureBytes.length, width: 1024, height: 1024, ...pixels } as File,
    pictureBytes.toString('base64')
  );

const rowAsSystem = async (fileId: string): Promise<File> => (await getDbAsSystem().get(tables.File, { id: fileId }))!;

/** The answer a row carries — `null` for a row that carries none. */
const transparentOf = (row: File): boolean | null => row.transparent ?? null;

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

describe('a rendition of a picture carries whether its pixels are see-through', () => {
  it('the ingest door: the preview and the stage deriveVariants makes of a see-through mark read `transparent` true off their own rows; the maker’s own answer stays its own', async () => {
    const mark = await createOwnerPicture('mark.png', { transparent: true });

    const { variants } = await new FileStorage().deriveVariants(mark, pictureBytes);

    expect(Object.keys(variants).sort()).toEqual(['preview', 'stage']);
    for (const kind of ['preview', 'stage'] as const) {
      const variant = await rowAsSystem(variants[kind]!.id);
      expect(transparentOf(variant)).toBe(true);
      expect([variant.type, variant.width, variant.height]).toEqual([
        'image/webp',
        kind === 'stage' ? 1600 : 512,
        kind === 'stage' ? 800 : 256,
      ]);
    }
  });

  it('the read path’s door: the stage getVariant derives on the first request reads true', async () => {
    const mark = await createOwnerPicture('existing-mark.png', { transparent: true });
    expect((await rowAsSystem(mark.id)).stage?._id ?? null).toBeNull();

    const stage = (await new FileStorage().getVariant(mark.id, 'stage'))!;

    expect(stage.variantOf?._id).toEqual(mark.id);
    expect(transparentOf(await rowAsSystem(stage.id))).toBe(true);
  });

  it('the copy for others reads true — the same pixels, the metadata off', async () => {
    const mark = await createOwnerPicture('shared-mark.png', { transparent: true });

    const copy = await copyForOthersOf(mark);

    expect(copy.scope).toEqual(owner.id);
    expect(transparentOf(copy)).toBe(true);
  });

  it('an opaque picture’s renditions read false — the answer travels as it is, never dropped to unset', async () => {
    const photo = await createOwnerPicture('photo.png', { transparent: false });

    const { variants } = await new FileStorage().deriveVariants(photo, pictureBytes);
    const copy = await copyForOthersOf(photo);

    expect(transparentOf(await rowAsSystem(variants.preview!.id))).toBe(false);
    expect(transparentOf(await rowAsSystem(variants.stage!.id))).toBe(false);
    expect(transparentOf(copy)).toBe(false);
  });

  it('a picture nothing probed derives renditions with no answer — nothing is invented, at any door', async () => {
    const unprobed = await createOwnerPicture('unprobed.png');
    expect(transparentOf(await rowAsSystem(unprobed.id))).toBeNull();

    const { variants } = await new FileStorage().deriveVariants(unprobed, pictureBytes);
    const copy = await copyForOthersOf(unprobed);

    expect(transparentOf(await rowAsSystem(variants.preview!.id))).toBeNull();
    expect(transparentOf(await rowAsSystem(variants.stage!.id))).toBeNull();
    expect(transparentOf(copy)).toBeNull();
  });
});
