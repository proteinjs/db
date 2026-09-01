module.exports = {
  roots: ['<rootDir>/test'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.tsx?$',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    // One copy per process in symlinked-workspace estates (the second-copy class —
    // user-server/app-ui precedent, TRAIN_MANIFEST_5 §6.15): ServiceAuth and the suites must
    // share ONE UserAuth class object for the static-stub idiom to reach the real gate, and
    // reflection's SourceRepository is a process singleton. CI's npm dedupe makes these no-ops.
    '^@proteinjs/reflection$': '<rootDir>/node_modules/@proteinjs/reflection',
    '^@proteinjs/user-auth$': '<rootDir>/node_modules/@proteinjs/user-auth',
  },
  testEnvironment: 'node',
};
