// Node10/classic-resolution shim for the `./test` subpath (thought-common's test.js convention).
// Consumers compiled with `module: commonjs` + default (node10) resolution AND a
// `@proteinjs/*` tsconfig paths mapping resolve this subpath as a mapped FILE PATH, which
// bypasses the `exports`/`typesVersions` maps entirely and — in workspace-symlinked installs,
// where the source tree is present — lands on `test/index.ts` SOURCE. TypeScript then realpaths
// the sources outside the consumer's rootDir (TS6059) and `noEmitOnError` blocks the consumer's
// own emit (the ts-jest "Unable to process TestEnvironment.ts" cold-cache failure class,
// 2026-08-17). This root stub wins the mapped-path lookup before directory resolution, so every
// install shape resolves to the built dist instead.
module.exports = require('./dist/generated/test/index.js');
