// Node10/classic-resolution stub for the `./test` subpath, owned by reflection-build.
// Consumers that bypass the exports map (node10 resolution, tsconfig paths mappings) resolve
// this file path first, so every install shape loads the built dist — never sources.
module.exports = require('./dist/generated/test/index.js');
