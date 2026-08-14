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
    // package's copies so jest loads one React (hooks) — the util-ui precedent.
    '^react$': '<rootDir>/node_modules/react',
    '^react/(.*)$': '<rootDir>/node_modules/react/$1',
    '^react-dom$': '<rootDir>/node_modules/react-dom',
    '^react-dom/(.*)$': '<rootDir>/node_modules/react-dom/$1',
  },
};
