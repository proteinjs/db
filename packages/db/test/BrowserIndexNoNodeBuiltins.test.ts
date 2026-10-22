import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import webpack from 'webpack';

/**
 * THE LAW: this package's browser-facing index never reaches a Node builtin. `@proteinjs/db` is
 * one package for both halves — the browser's Db talks through DbService, the server's through a
 * driver — and its public entry (`dist/generated/index.js`, what a consumer's webpack bundles)
 * must bundle for the browser as it stands; a consumer app has no business patching the
 * library's reach with a `resolve.fallback`. The source-record sync (it reads package.json files
 * off the booting process) is the server-only code that broke this line in db 1.55–1.58 — a
 * webpack 5 client bundle met its `fs` and booted to nothing — and now lives behind the
 * `@proteinjs/db/source` subpath. This guard holds the line for every module to come.
 *
 * Mechanics: webpack 5.88.2 — the consumer's bundler, at app-ui's version — bundles the built
 * browser index for `target: 'web'` with this package's own dependencies external, so the only
 * resolution left to fail is a Node builtin's, which webpack 5 refuses by name ("Module not
 * found: Error: Can't resolve 'fs'"). It refuses as a WARNING when the reach sits in a try/catch
 * (an optional dependency) — exactly how 1.58.0's runner reached `fs`, through a renamed
 * `require` that esbuild never sees but webpack's parser tracks — so errors AND warnings must be
 * empty. The module list then pins the subpath out of the graph by path.
 *
 * The one named exception: four encryption modules import `crypto` (since before 1.54.1), and
 * consumers substitute a browser build for it (app-ui's webpack: `fallback.crypto:
 * crypto-browserify`). Pinned to exactly those four files — a fifth reader of `crypto`, or any
 * other builtin anywhere, is red.
 */
const packageDir = path.join(__dirname, '..');
const BROWSER_INDEX = 'dist/generated/index.js';
const SERVER_ONLY_SUBPATH = /(^|\/)dist\/source\//;
const CRYPTO_READERS = [
  'dist/src/encryption/DataKeyStore.js',
  'dist/src/encryption/EncryptionEnvelope.js',
  'dist/src/encryption/InMemoryMasterKeyProvider.js',
  'dist/src/encryption/SearchTokenizer.js',
];

/** What one browser bundle of the index came to. */
type Bundle = { errors: string[]; warnings: string[]; modules: string[]; cryptoReaders: string[] };

/** `fs.rmSync` (Node 14.14+; this package's @types/node predates it). */
const removeDirectory = (directory: string) =>
  (fs as unknown as { rmSync(target: string, options: { recursive: true; force: true }): void }).rmSync(directory, {
    recursive: true,
    force: true,
  });

/** This package's dependencies: a consumer resolves those itself; never this bundle's concern. */
const dependencies = (): string[] =>
  Object.keys(JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).dependencies);

const bundleBrowserIndex = (): Promise<Bundle> =>
  new Promise((resolve, reject) => {
    const names = dependencies();
    const cryptoReaders = new Set<string>();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-browser-index-'));
    webpack(
      {
        mode: 'none',
        target: 'web',
        context: packageDir,
        entry: path.join(packageDir, BROWSER_INDEX),
        output: { path: outDir, filename: 'browser.js' },
        externals: [
          ({ request, contextInfo }, callback) => {
            if (names.some((name) => request === name || !!request?.startsWith(`${name}/`))) {
              return callback(undefined, `commonjs ${request}`);
            }

            // The crypto exception, pinned to its readers; every other builtin stays webpack's own refusal.
            if (request && /^(node:)?crypto$/.test(request)) {
              const issuer = path.relative(packageDir, contextInfo?.issuer ?? '');
              cryptoReaders.add(issuer);
              if (CRYPTO_READERS.includes(issuer)) {
                return callback(undefined, `commonjs ${request}`);
              }
            }

            callback();
          },
        ],
      },
      (error, stats) => {
        removeDirectory(outDir);
        if (error || !stats) {
          return reject(error ?? new Error('webpack produced no stats'));
        }

        const json = stats.toJson({ all: false, errors: true, warnings: true, modules: true });
        const line = ({ message, moduleName }: { message: string; moduleName?: string }) =>
          `${message.split('\n')[0]} (${moduleName})`;
        resolve({
          errors: (json.errors ?? []).map(line),
          warnings: (json.warnings ?? []).map(line),
          modules: (json.modules ?? []).map((module) => module.name ?? ''),
          cryptoReaders: Array.from(cryptoReaders).sort(),
        });
      }
    );
  });

describe('the browser index (dist/generated/index.js) bundles for the browser', () => {
  let bundle: Bundle;

  beforeAll(async () => {
    bundle = await bundleBrowserIndex();
  }, 60000);

  it('reaches no Node builtin: webpack resolved every module with only the dependencies external', () => {
    expect(bundle.errors).toEqual([]);
    expect(bundle.warnings).toEqual([]);
  });

  it('never imports the server-only source-record sync (the @proteinjs/db/source subpath)', () => {
    expect(bundle.modules.length).toBeGreaterThan(0);
    expect(bundle.modules.filter((module) => SERVER_ONLY_SUBPATH.test(module))).toEqual([]);
  });

  it('pins the crypto exception to exactly its four readers', () => {
    expect(bundle.cryptoReaders).toEqual(CRYPTO_READERS.slice().sort());
  });
});
