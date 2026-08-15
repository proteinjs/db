module.exports = {
  roots: ['<rootDir>/test'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.tsx?$',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  testEnvironment: 'node',
  moduleNameMapper: {
    // The symlinked @proteinjs/ui carries its own react tree. Pin the singletons to THIS
    // package's copies so jest loads one React (hooks) — the util-ui precedent. react-router
    // and react-query are pinned for the same reason: their contexts (Router, QueryClient)
    // must be the same module instance in the test and inside @proteinjs/ui components.
    '^react$': '<rootDir>/node_modules/react',
    '^react/(.*)$': '<rootDir>/node_modules/react/$1',
    '^react-dom$': '<rootDir>/node_modules/react-dom',
    '^react-dom/(.*)$': '<rootDir>/node_modules/react-dom/$1',
    '^react-router$': '<rootDir>/node_modules/react-router',
    '^react-router-dom$': '<rootDir>/node_modules/react-router-dom',
    '^react-query$': '<rootDir>/node_modules/react-query',
    // jsdom tests resolve uuid's browser field (ESM, unparseable by jest); pin the CJS build.
    '^uuid$': '<rootDir>/node_modules/uuid/dist/index.js',
  },
};
