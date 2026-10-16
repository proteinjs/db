module.exports = {
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'plugin:prettier/recommended', 'prettier'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'prettier'],
  root: true,
  ignorePatterns: ['**/dist/*', '**/node_modules/*', '*.md'],

  rules: {
    'prettier/prettier': ['warn'],
    curly: ['warn'],
    'eol-last': ['warn', 'always'],
    'keyword-spacing': ['warn', { before: true }],
    'no-undef': 'off',
    // A caught error is named and used, or not bound at all: `catch (MissingFieldError)` binds EVERY
    // error under that name and filters nothing — the shape the two rules below refuse. A callback's
    // unused parameter is its signature (args: none).
    '@typescript-eslint/no-unused-vars': [
      'error',
      { vars: 'all', args: 'none', caughtErrors: 'all', ignoreRestSiblings: true },
    ],
    'no-restricted-syntax': [
      'error',
      {
        selector: 'CatchClause > Identifier[name=/^[A-Z]/]',
        message:
          'A catch binding named like a class is not a type filter: it binds every error. Name the error (catch (error)) and narrow it with instanceof.',
      },
    ],
    '@typescript-eslint/no-var-requires': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/prefer-as-const': 'off',
    '@typescript-eslint/ban-types': 'off',
  },
};
