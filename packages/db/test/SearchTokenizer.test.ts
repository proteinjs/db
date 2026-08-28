import { randomBytes } from 'crypto';
import { SearchTokenizer } from '../src/encryption/SearchTokenizer';

/**
 * The token/fingerprint contract behind encrypted contains-search (§ Firmed-up plan,
 * TRUST_AND_COMPLIANCE): word + trigram + short-prefix tokens at write; per-word fragment
 * covers at query; HMAC fingerprints computable only with the owner's index key.
 */
describe('SearchTokenizer', () => {
  const tokenizer = new SearchTokenizer();

  test('value tokens: words, trigrams, and 1-2 letter word prefixes', () => {
    const tokens = tokenizer.tokensForValue('Groceries list');
    expect(tokens).toContain('w:groceries');
    expect(tokens).toContain('w:list');
    // the doc's example trigrams
    for (const trigram of ['gro', 'roc', 'oce', 'cer', 'eri', 'rie', 'ies']) {
      expect(tokens).toContain(`t:${trigram}`);
    }
    expect(tokens).toContain('p:g');
    expect(tokens).toContain('p:gr');
    expect(tokens).toContain('p:l');
    expect(tokens).toContain('p:li');
  });

  test('normalization: case folds, punctuation splits words, numbers are word characters', () => {
    const tokens = tokenizer.tokensForValue('N3xa-Dev NOTES');
    expect(tokens).toContain('w:n3xa');
    expect(tokens).toContain('w:dev');
    expect(tokens).toContain('w:notes');
  });

  test('query fragments: >=3 char words cover by trigrams; 1-2 char words by word-prefix', () => {
    const fragments = tokenizer.fragmentsForQuery('cake ry');
    expect(fragments).toContain('t:cak');
    expect(fragments).toContain('t:ake');
    expect(fragments).toContain('p:ry');
    expect(fragments).not.toContain('t:ry');
  });

  test('a true substring match always covers: value tokens superset query fragments (>=3 char words)', () => {
    // "cake factory" appears inside "pancake factory list" — every query fragment must be
    // present in the value's token set, or the index would miss a true match.
    const valueTokens = new Set(tokenizer.tokensForValue('Pancake factory list'));
    for (const fragment of tokenizer.fragmentsForQuery('cake factory')) {
      expect(valueTokens.has(fragment)).toBe(true);
    }
  });

  test('fingerprints are keyed: same token, different keys, unrelated fingerprints', () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    expect(tokenizer.fingerprint('w:divorce', keyA)).not.toBe(tokenizer.fingerprint('w:divorce', keyB));
    expect(tokenizer.fingerprint('w:divorce', keyA)).toBe(tokenizer.fingerprint('w:divorce', keyA));
  });

  test('equality fingerprint covers the exact value (case-exact, distinct from token space)', () => {
    const key = randomBytes(32);
    expect(tokenizer.equalityFingerprint('Divorce', key)).not.toBe(tokenizer.equalityFingerprint('divorce', key));
    expect(tokenizer.equalityFingerprint('divorce', key)).not.toBe(tokenizer.fingerprint('w:divorce', key));
  });

  test('sort prefix: normalized first N characters, nothing else', () => {
    expect(tokenizer.sortPrefix('Therapy notes', 3)).toBe('the');
    expect(tokenizer.sortPrefix('ab', 3)).toBe('ab');
  });
});
