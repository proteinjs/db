import { EncryptionEnvelope } from './EncryptionEnvelope';
import type { DataKeyMaterial } from './DataKeyStore';
import { LeafPath, LeafPolicy } from './LeafPolicy';

/** What the walker needs to know about one stored JSON value against a policy. */
export interface LeafAudit {
  /** Content-classed nodes stored plaintext (pending `encrypt`). */
  plaintextContent: string[];
  /** Envelopes stored at paths the policy now calls metadata (pending convergence after a policy change). */
  envelopedMetadata: string[];
  /** Every envelope in the value, with the key it names. */
  envelopes: { path: string; owner: string; version: number }[];
}

/**
 * The leaf codec behind `encrypted: { leaves }`: walks a JSON document at the serialize seam
 * and replaces content nodes with envelopes (`encrypt`), and walks stored documents at the
 * deserialize seam replacing every envelope it finds with its plaintext (`decrypt` — POLICY-FREE,
 * so mixed rows, unknown types, and a decrypt-out rollback all read correctly by construction).
 *
 * Storage shapes (see `LeafPolicy`):
 * - scalar content → an envelope STRING of the scalar's JSON text (`"hello"` → `pjenc:1:…`,
 *   `42` → `pjenc:1:…`); decrypt JSON-parses it back, so numbers stay numbers;
 * - object/array content → `{ "__pjLeafEnc": "pjenc:1:…" }` (the envelope of the subtree's
 *   JSON text). Never a bare envelope string as the DOCUMENT: the Spanner driver infers a DML
 *   parameter's type from the JS value and a bare string is `STRING`, which a `JSON` column
 *   rejects — the same class `JsonColumn` documents for top-level arrays;
 * - object content with kept keys → `{ …kept, "__pjLeafEnc": "pjenc:1:…" }` (the envelope of
 *   the remaining keys); decrypt merges them back.
 *
 * `JsonColumn` wraps a top-level array as `{ "__jsonColumnArray": [...] }` BEFORE this codec
 * runs; the codec treats that wrapper as transparent (the array is the root `$`) and re-wraps
 * on the way out unless the whole value became one envelope object.
 *
 * Spanner normalization cannot hurt an envelope: object members are sorted and numbers may be
 * re-rendered, but string values are preserved exactly, and an envelope is a plain base64url
 * string leaf. Copy-on-hit on decrypt: a value with no envelope comes back by reference.
 */
export class LeafEnvelopeCodec {
  /** The subtree-envelope member: an object carrying this key IS one envelope (plus any kept keys). */
  static readonly ENC_KEY = '__pjLeafEnc';
  /** `JsonColumn`'s top-level array wrapper (spanner-common) — transparent here. */
  static readonly ARRAY_WRAPPER_KEY = '__jsonColumnArray';
  /** Well under Spanner's 80-level JSON nesting limit. */
  static readonly MAX_DEPTH = 64;
  private envelope = new EncryptionEnvelope();

  /** The stored shape of `value` under `policy`, every content node enveloped under `key`. */
  encrypt(value: unknown, policy: LeafPolicy, key: DataKeyMaterial): unknown {
    if (value === null || typeof value === 'undefined') {
      return value;
    }
    const { root, wrapped } = this.unwrapArray(value);
    const encrypted = this.encryptNode(root, [], policy, key, 0);
    if (wrapped && Array.isArray(encrypted)) {
      return { [LeafEnvelopeCodec.ARRAY_WRAPPER_KEY]: encrypted };
    }
    return encrypted;
  }

  /**
   * `value` with every envelope decrypted in place (subtree envelopes expanded, kept keys merged
   * back). Keys are fetched through `keyFor`, memoized per (owner, version) within the call.
   */
  async decrypt(
    value: unknown,
    keyFor: (owner: string, version: number) => Promise<DataKeyMaterial>
  ): Promise<unknown> {
    const memo = new Map<string, Promise<DataKeyMaterial>>();
    const memoizedKeyFor = (owner: string, version: number) => {
      const memoKey = `${owner}:${version}`;
      let pending = memo.get(memoKey);
      if (!pending) {
        pending = keyFor(owner, version);
        memo.set(memoKey, pending);
      }
      return pending;
    };
    return await this.decryptNode(value, memoizedKeyFor, 0);
  }

  /** Does `value` carry any envelope anywhere (string leaf or subtree marker)? */
  containsEnvelope(value: unknown, depth = 0): boolean {
    if (typeof value === 'string') {
      return this.envelope.isEnvelope(value);
    }
    if (!value || typeof value !== 'object' || depth > LeafEnvelopeCodec.MAX_DEPTH) {
      return false;
    }
    if (Array.isArray(value)) {
      return value.some((item) => this.containsEnvelope(item, depth + 1));
    }
    if (LeafEnvelopeCodec.ENC_KEY in (value as object)) {
      return true;
    }
    return Object.values(value as object).some((item) => this.containsEnvelope(item, depth + 1));
  }

  /** The stored `value` measured against `policy` — what the lifecycle walker decides pending-ness from. */
  audit(value: unknown, policy: LeafPolicy): LeafAudit {
    const audit: LeafAudit = { plaintextContent: [], envelopedMetadata: [], envelopes: [] };
    if (value === null || typeof value === 'undefined') {
      return audit;
    }
    const { root } = this.unwrapArray(value);
    this.auditNode(root, [], policy, audit, 0);
    return audit;
  }

  private encryptNode(
    node: unknown,
    segments: (string | number)[],
    policy: LeafPolicy,
    key: DataKeyMaterial,
    depth: number
  ): unknown {
    this.assertDepth(depth, segments);
    if (typeof node === 'undefined') {
      return node;
    }
    if (typeof node === 'string' && this.envelope.isEnvelope(node)) {
      return node; // already ciphertext (a value re-serialized from a raw read) — never double-encrypt
    }
    const isObject = node !== null && typeof node === 'object' && !Array.isArray(node);
    if (isObject && LeafEnvelopeCodec.ENC_KEY in (node as object)) {
      return node; // already a subtree envelope
    }

    const decision = policy.classify(LeafPath.format(segments), node);
    if (decision === 'metadata') {
      if (Array.isArray(node)) {
        return node.map((item, index) => this.encryptNode(item, [...segments, index], policy, key, depth + 1));
      }
      if (isObject) {
        const out: { [key: string]: unknown } = {};
        for (const [childKey, childValue] of Object.entries(node as object)) {
          if (typeof childValue === 'undefined') {
            continue;
          }
          out[childKey] = this.encryptNode(childValue, [...segments, childKey], policy, key, depth + 1);
        }
        return out;
      }
      return node;
    }

    if (typeof decision === 'object' && isObject) {
      const kept: { [key: string]: unknown } = {};
      const rest: { [key: string]: unknown } = {};
      for (const [childKey, childValue] of Object.entries(node as object)) {
        if (typeof childValue === 'undefined') {
          continue;
        }
        (decision.keep.includes(childKey) ? kept : rest)[childKey] = childValue;
      }
      return { ...kept, [LeafEnvelopeCodec.ENC_KEY]: this.envelope.encrypt(JSON.stringify(rest), key) };
    }

    const ciphertext = this.envelope.encrypt(JSON.stringify(node), key);
    if (node !== null && typeof node === 'object') {
      return { [LeafEnvelopeCodec.ENC_KEY]: ciphertext };
    }
    return ciphertext;
  }

  private async decryptNode(
    node: unknown,
    keyFor: (owner: string, version: number) => Promise<DataKeyMaterial>,
    depth: number
  ): Promise<unknown> {
    if (typeof node === 'string') {
      const parsed = this.envelope.parse(node);
      if (!parsed) {
        return node;
      }
      return this.parseJson(this.envelope.decrypt(node, await keyFor(parsed.owner, parsed.version)));
    }
    if (!node || typeof node !== 'object' || depth > LeafEnvelopeCodec.MAX_DEPTH) {
      return node;
    }
    if (Array.isArray(node)) {
      let changed = false;
      const out: unknown[] = [];
      for (const item of node) {
        const decrypted = await this.decryptNode(item, keyFor, depth + 1);
        changed = changed || decrypted !== item;
        out.push(decrypted);
      }
      return changed ? out : node;
    }

    const record = node as { [key: string]: unknown };
    const subtreeEnvelope = record[LeafEnvelopeCodec.ENC_KEY];
    let changed = false;
    const rest: { [key: string]: unknown } = {};
    for (const [childKey, childValue] of Object.entries(record)) {
      if (childKey === LeafEnvelopeCodec.ENC_KEY) {
        continue;
      }
      const decrypted = await this.decryptNode(childValue, keyFor, depth + 1);
      changed = changed || decrypted !== childValue;
      rest[childKey] = decrypted;
    }
    if (typeof subtreeEnvelope === 'string') {
      const parsed = this.envelope.parse(subtreeEnvelope);
      if (parsed) {
        const inner = this.parseJson(
          this.envelope.decrypt(subtreeEnvelope, await keyFor(parsed.owner, parsed.version))
        );
        const hasKept = Object.keys(rest).length > 0;
        if (hasKept && inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
          return { ...rest, ...(inner as object) };
        }
        return inner;
      }
    }
    return changed ? rest : node;
  }

  private auditNode(
    node: unknown,
    segments: (string | number)[],
    policy: LeafPolicy,
    audit: LeafAudit,
    depth: number
  ): void {
    this.assertDepth(depth, segments);
    const path = LeafPath.format(segments);
    const isObject = node !== null && typeof node === 'object' && !Array.isArray(node);

    if (typeof node === 'string') {
      const parsed = this.envelope.parse(node);
      if (parsed) {
        audit.envelopes.push({ path, owner: parsed.owner, version: parsed.version });
        if (policy.classify(path, node) === 'metadata') {
          audit.envelopedMetadata.push(path);
        }
        return;
      }
    }
    if (isObject && typeof (node as { [key: string]: unknown })[LeafEnvelopeCodec.ENC_KEY] === 'string') {
      const parsed = this.envelope.parse((node as { [key: string]: unknown })[LeafEnvelopeCodec.ENC_KEY]);
      if (parsed) {
        audit.envelopes.push({ path, owner: parsed.owner, version: parsed.version });
        if (policy.classify(path, node) === 'metadata') {
          audit.envelopedMetadata.push(path);
        }
        return;
      }
    }

    const decision = policy.classify(path, node);
    if (decision !== 'metadata') {
      audit.plaintextContent.push(path);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => this.auditNode(item, [...segments, index], policy, audit, depth + 1));
    } else if (isObject) {
      for (const [childKey, childValue] of Object.entries(node as object)) {
        this.auditNode(childValue, [...segments, childKey], policy, audit, depth + 1);
      }
    }
  }

  private unwrapArray(value: unknown): { root: unknown; wrapped: boolean } {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Array.isArray((value as { [key: string]: unknown })[LeafEnvelopeCodec.ARRAY_WRAPPER_KEY]) &&
      Object.keys(value as object).length === 1
    ) {
      return { root: (value as { [key: string]: unknown })[LeafEnvelopeCodec.ARRAY_WRAPPER_KEY], wrapped: true };
    }
    return { root: value, wrapped: false };
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return text; // not produced by this codec (a whole-value string envelope) — the raw plaintext
    }
  }

  private assertDepth(depth: number, segments: (string | number)[]): void {
    if (depth > LeafEnvelopeCodec.MAX_DEPTH) {
      throw new Error(
        `Leaf encryption refuses JSON nested deeper than ${LeafEnvelopeCodec.MAX_DEPTH} levels (at ${LeafPath.format(segments)})`
      );
    }
  }
}
