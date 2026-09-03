/**
 * Leaf-envelope policies — the declaration side of `encrypted: { leaves }` on a JSON-typed
 * column (plans/ENCRYPTED_THOUGHT_OBJECT.md §4): the column stays a queryable JSON document
 * and only the WORDS inside it become ciphertext. A policy classifies every node of the
 * document by PATH (and value):
 *
 * - `'content'` — the node is enveloped in place. A string/number/boolean/null becomes one
 *   envelope string (`pjenc:1:…` of its JSON text, so the JSON type round-trips); an object or
 *   array subtree becomes `{ "__pjLeafEnc": "pjenc:1:…" }` (one envelope for the whole subtree
 *   — a JSON column cannot hold a bare string document, see `LeafEnvelopeCodec`).
 * - `{ content: true, keep: [...] }` — an object subtree is enveloped EXCEPT the listed keys,
 *   which stay plaintext beside the envelope (`{ "id": "s1", "__pjLeafEnc": "pjenc:…" }`) —
 *   the ids-skeleton shape for arrays of `{ id, …words }` entries.
 * - `'metadata'` — the node stays plaintext; objects and arrays are DESCENDED into so their
 *   own leaves get classified.
 *
 * Reads need no policy: the codec decrypts whatever envelopes it finds. The policy is consulted
 * on WRITES (the serialize seam) and by the lifecycle walker (is this stored row converged on
 * the current policy?). Policies are derived by the owning domain layer (a thought type's own
 * declaration derives its policy; the framework never knows a domain key), either statically
 * (`LeafPolicy`) or per row (`LeafPolicySource` — a resolver that reads the row's discriminator,
 * e.g. its `type` reference).
 */

export type LeafClass = 'content' | 'metadata';

/** A classification answer; see the module doc for what each means at a node. */
export type LeafDecision = LeafClass | { content: true; keep: string[] };

export interface LeafPolicy {
  /** Classify the node at `path` (a `$`-rooted JSONPath, see {@link LeafPath.format}) holding `value`. */
  classify(path: string, value: unknown): LeafDecision;
  /**
   * Content string paths that ALSO derive search tokens (fingerprinted words in the derived
   * token table under a path-qualified column name, `<column>$.path`). The v1 door is closed
   * by every product declaration (body search tokens are off — founder ruling 2026-09-03);
   * the plumbing exists so a type can open it per leaf.
   */
  searchable?: string[];
}

/** A per-row policy resolver: the row's discriminator decides which policy applies. */
export interface LeafPolicySource {
  /**
   * Row property names the resolver reads (e.g. `['type']`). The lifecycle walker selects them
   * beside the walked column so pending-ness is decided under the row's own policy.
   */
  dependsOn?: string[];
  /** The policy for `row` (property-keyed; may be a partial row — an update payload overlaid on the stored row). */
  resolve(row: any): LeafPolicy | Promise<LeafPolicy>;
  /**
   * True when `path` is metadata under EVERY policy this source can produce — what a raw-SQL
   * site (`JSON_VALUE`, `JSON_SET`) must be able to assert before touching a path
   * (`LeafPaths.assertMetadata`). Absent = nothing is asserted metadata for raw SQL.
   */
  isAlwaysMetadata?(path: string): boolean;
}

export type LeafPolicyDeclaration = LeafPolicy | LeafPolicySource;

export const isLeafPolicySource = (declaration: LeafPolicyDeclaration): declaration is LeafPolicySource =>
  typeof (declaration as LeafPolicySource).resolve === 'function';

type PatternSegment = string | number | { any: true } | { deep: true };

/**
 * The path grammar shared by policies and raw-SQL sites: `$` is the root; `.key` or `["key"]`
 * selects a member; `[n]` an array element; `[*]` / `.*` any ONE member or element; `.**`
 * any run of segments (zero or more). Paths are FORMATTED from segments by {@link format}
 * and PARSED by {@link parse}; {@link matches} tests a concrete path against a pattern.
 * Never sent to a database — the walker resolves patterns in process.
 */
export class LeafPath {
  static readonly ROOT = '$';
  private static readonly IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  static format(segments: (string | number)[]): string {
    let out = LeafPath.ROOT;
    for (const segment of segments) {
      if (typeof segment === 'number') {
        out += `[${segment}]`;
      } else if (LeafPath.IDENTIFIER.test(segment)) {
        out += `.${segment}`;
      } else {
        out += `[${JSON.stringify(segment)}]`;
      }
    }
    return out;
  }

  /** Parse a path or pattern into segments (`*` / `[*]` → any-one, `**` → any-run). */
  static parse(path: string): PatternSegment[] {
    if (!path.startsWith(LeafPath.ROOT)) {
      throw new Error(`Leaf paths start at '$': ${path}`);
    }
    const segments: PatternSegment[] = [];
    let i = 1;
    while (i < path.length) {
      const ch = path[i];
      if (ch === '.') {
        i++;
        const start = i;
        while (i < path.length && path[i] !== '.' && path[i] !== '[') {
          i++;
        }
        const name = path.slice(start, i);
        if (!name) {
          throw new Error(`Empty member name in leaf path: ${path}`);
        }
        segments.push(name === '**' ? { deep: true } : name === '*' ? { any: true } : name);
        continue;
      }
      if (ch === '[') {
        const close = path.indexOf(']', i);
        if (close < 0) {
          throw new Error(`Unterminated '[' in leaf path: ${path}`);
        }
        const inner = path.slice(i + 1, close);
        i = close + 1;
        if (inner === '*') {
          segments.push({ any: true });
        } else if (/^\d+$/.test(inner)) {
          segments.push(parseInt(inner, 10));
        } else if (inner.startsWith('"')) {
          segments.push(JSON.parse(inner) as string);
        } else {
          throw new Error(`Bad bracket segment '[${inner}]' in leaf path: ${path}`);
        }
        continue;
      }
      throw new Error(`Unexpected '${ch}' in leaf path: ${path}`);
    }
    return segments;
  }

  /** Does the concrete `path` match `pattern`? (`*` = one segment, `**` = any run, `[n]` = that index.) */
  static matches(pattern: string, path: string): boolean {
    return LeafPath.matchSegments(LeafPath.parse(pattern), LeafPath.parse(path), 0, 0);
  }

  private static matchSegments(pattern: PatternSegment[], path: PatternSegment[], p: number, q: number): boolean {
    if (p === pattern.length) {
      return q === path.length;
    }
    const segment = pattern[p];
    if (typeof segment === 'object' && 'deep' in segment) {
      for (let skip = q; skip <= path.length; skip++) {
        if (LeafPath.matchSegments(pattern, path, p + 1, skip)) {
          return true;
        }
      }
      return false;
    }
    if (q === path.length) {
      return false;
    }
    const actual = path[q];
    const segmentMatches =
      typeof segment === 'object'
        ? true // any-one
        : typeof segment === 'number'
          ? actual === segment
          : typeof actual === 'string' && actual === segment;
    return segmentMatches && LeafPath.matchSegments(pattern, path, p + 1, q + 1);
  }
}

export interface LeafPathPolicyRules {
  /** Patterns whose STRING values stay plaintext (objects/arrays at these paths are descended). */
  metadata?: string[];
  /** Patterns enveloped WHOLE (any JSON type; a subtree becomes one envelope). */
  content?: string[];
  /** Object subtrees enveloped except the kept keys (the ids-skeleton shape). */
  contentKeeping?: { path: string; keep: string[] }[];
  /** Default for strings not matched above. */
  strings: LeafClass;
  /** Default for numbers / booleans / null not matched above. */
  nonStrings: LeafClass;
}

/**
 * A pattern-driven policy: explicit `content` / `contentKeeping` patterns win, then explicit
 * `metadata` patterns, then the defaults by JSON type. Objects and arrays are metadata
 * (descended) unless a `content` / `contentKeeping` pattern names them — a subtree is never
 * enveloped by default, so a document's shape stays queryable while its words do not.
 */
export class LeafPathPolicy implements LeafPolicy {
  readonly searchable?: string[];

  constructor(
    private rules: LeafPathPolicyRules,
    searchable?: string[]
  ) {
    this.searchable = searchable;
  }

  classify(path: string, value: unknown): LeafDecision {
    const keeping = this.rules.contentKeeping?.find((entry) => LeafPath.matches(entry.path, path));
    if (keeping && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { content: true, keep: keeping.keep };
    }
    if (this.rules.content?.some((pattern) => LeafPath.matches(pattern, path))) {
      return 'content';
    }
    if (this.rules.metadata?.some((pattern) => LeafPath.matches(pattern, path))) {
      return 'metadata';
    }
    if (value !== null && typeof value === 'object') {
      return 'metadata';
    }
    return typeof value === 'string' ? this.rules.strings : this.rules.nonStrings;
  }

  /** True when a pattern in `metadata` covers `path` and nothing in `content` does. */
  isAlwaysMetadata(path: string): boolean {
    if (this.rules.content?.some((pattern) => LeafPath.matches(pattern, path))) {
      return false;
    }
    if (this.rules.contentKeeping?.some((entry) => LeafPath.matches(entry.path, path))) {
      return false;
    }
    return !!this.rules.metadata?.some((pattern) => LeafPath.matches(pattern, path));
  }
}

/** Every string is content; numbers/booleans stay plaintext; the shape stays queryable. The all-words default. */
export const ALL_STRINGS_CONTENT: LeafPolicy = new LeafPathPolicy({ strings: 'content', nonStrings: 'metadata' });

/** The whole document is ONE envelope (`{ "__pjLeafEnc": … }`) — nothing about its shape leaks. */
export const WHOLE_VALUE_CONTENT: LeafPolicy = new LeafPathPolicy({
  content: [LeafPath.ROOT],
  strings: 'content',
  nonStrings: 'content',
});

/**
 * An array of `{ id, …words }` entries: each entry is one envelope with its `id` handle kept
 * plaintext beside it (`IS NULL` / cardinality queries keep working; the title/url length
 * split does not leak).
 */
export const ID_SKELETON_ENTRIES: LeafPolicy = new LeafPathPolicy({
  contentKeeping: [{ path: '$[*]', keep: ['id'] }],
  strings: 'content',
  nonStrings: 'metadata',
});
