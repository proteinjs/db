import { createHmac } from 'crypto';
import { Base64Url } from './Base64Url';

/**
 * Search tokens and keyed fingerprints for encrypted columns
 * (`encrypted: { searchable: 'contains' | 'equality' }`).
 *
 * Definitions:
 * - **Search token** — a normalized fragment of a text value: its lowercased words, each
 *   word's trigrams (three-letter fragments), and each word's 1- and 2-letter prefixes
 *   (so 1–2 character queries behave as word-prefix search).
 * - **Keyed fingerprint (HMAC-SHA256)** — computable only with the owner's index key
 *   (`DataKeyMaterial.indexKey`); without it, stored fingerprints can be neither created
 *   nor reversed, so raw database access cannot probe ("does any title contain X?").
 *
 * Query-side cover: a candidate row must hold ALL of the query's fragment fingerprints.
 * The cover can over-match (fragments present but not contiguous) and — for query words of
 * ≥3 characters — can never under-match; the query layer verifies every candidate against
 * the decrypted value before returning it (the pg_trgm recheck semantics), so results are
 * exact. Documented narrowing: a 1–2 character query WORD matches word beginnings only
 * (a 1–2 character mid-word substring is unsupported and behaves as prefix search).
 *
 * Equality fingerprints cover the EXACT serialized value (no normalization): `=` keeps its
 * native case-sensitive semantics with no recheck, and a unique index on the fingerprint
 * column enforces per-owner value uniqueness.
 */
export class SearchTokenizer {
  /** All write-side tokens of `value` (deduplicated, un-fingerprinted). */
  tokensForValue(value: string): string[] {
    const tokens = new Set<string>();
    for (const word of this.words(value)) {
      tokens.add(`w:${word}`);
      tokens.add(`p:${word.slice(0, 1)}`);
      if (word.length >= 2) {
        tokens.add(`p:${word.slice(0, 2)}`);
      }
      for (const trigram of this.trigrams(word)) {
        tokens.add(`t:${trigram}`);
      }
    }

    return Array.from(tokens);
  }

  /**
   * The query-side fragment cover of `query`: for each query word, its trigrams (≥3 chars)
   * or its prefix token (1–2 chars). Every fragment must match for a row to be a candidate.
   */
  fragmentsForQuery(query: string): string[] {
    const fragments = new Set<string>();
    for (const word of this.words(query)) {
      if (word.length >= 3) {
        for (const trigram of this.trigrams(word)) {
          fragments.add(`t:${trigram}`);
        }
      } else {
        fragments.add(`p:${word}`);
      }
    }

    return Array.from(fragments);
  }

  /** Keyed fingerprint of one token. */
  fingerprint(token: string, indexKey: Buffer): string {
    return Base64Url.encode(createHmac('sha256', indexKey).update(token, 'utf8').digest());
  }

  fingerprints(tokens: string[], indexKey: Buffer): string[] {
    return tokens.map((token) => this.fingerprint(token, indexKey));
  }

  /** Whole-value equality fingerprint — over the exact serialized value (see class doc). */
  equalityFingerprint(value: string, indexKey: Buffer): string {
    return Base64Url.encode(createHmac('sha256', indexKey).update(`eq:${value}`, 'utf8').digest());
  }

  /**
   * The declared bounded reveal for `encrypted: { sortKey: { revealPrefix: N } }`: the
   * normalized (lowercased) first N characters, stored beside the ciphertext for native
   * ORDER BY. Raw database access can read those N characters — the declared, documented
   * leak, chosen at the schema, never the default.
   */
  sortPrefix(value: string, revealPrefix: number): string {
    return value.toLowerCase().slice(0, revealPrefix);
  }

  private words(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 0);
  }

  private trigrams(word: string): string[] {
    const trigrams: string[] = [];
    for (let i = 0; i + 3 <= word.length; i++) {
      trigrams.push(word.slice(i, i + 3));
    }

    return trigrams;
  }
}
