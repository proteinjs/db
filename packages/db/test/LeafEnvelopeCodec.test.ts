import { randomBytes } from 'crypto';
import { EncryptionEnvelope } from '../src/encryption/EncryptionEnvelope';
import { DataKeyMaterial } from '../src/encryption/DataKeyStore';
import { LeafEnvelopeCodec } from '../src/encryption/LeafEnvelopeCodec';
import {
  ALL_STRINGS_CONTENT,
  ID_SKELETON_ENTRIES,
  LeafPath,
  LeafPathPolicy,
  WHOLE_VALUE_CONTENT,
} from '../src/encryption/LeafPolicy';

const keyFor = (owner: string, version = 1): DataKeyMaterial => ({
  owner,
  version,
  cipherKey: randomBytes(32),
  indexKey: randomBytes(32),
});

const ENC = LeafEnvelopeCodec.ENC_KEY;
const ARR = LeafEnvelopeCodec.ARRAY_WRAPPER_KEY;

/**
 * The leaf codec's storage contract (ENCRYPTED_THOUGHT_OBJECT §4.1): words become envelopes in
 * place, the document's shape and facts stay plaintext JSON, and reads need no policy.
 */
describe('LeafEnvelopeCodec', () => {
  const codec = new LeafEnvelopeCodec();
  const envelope = new EncryptionEnvelope();
  const key = keyFor('owner-a');
  const keys = new Map<string, DataKeyMaterial>([[`${key.owner}:${key.version}`, key]]);
  const lookups: string[] = [];
  const keyLookup = async (owner: string, version: number) => {
    lookups.push(`${owner}:${version}`);
    const material = keys.get(`${owner}:${version}`);
    if (!material) {
      throw new Error(`no key ${owner}:${version}`);
    }
    return material;
  };

  const textPolicy = new LeafPathPolicy({
    metadata: ['$.type', '$.children.**.adornment', '$.content.thoughtTypeId'],
    strings: 'content',
    nonStrings: 'metadata',
  });

  beforeEach(() => lookups.splice(0));

  test('a text-shaped document: content/link envelope in place; type, fontSize, bold, nested overrides stay plaintext', async () => {
    const doc = {
      content: 'the words inside',
      type: 'h2',
      fontSize: 24,
      bold: true,
      link: 'https://example.test/private',
      children: { overrideThought: { adornment: 'bullet' } },
    };
    const stored = codec.encrypt(doc, textPolicy, key) as any;

    expect(envelope.isEnvelope(stored.content)).toBe(true);
    expect(envelope.isEnvelope(stored.link)).toBe(true);
    expect(stored.type).toBe('h2');
    expect(stored.fontSize).toBe(24);
    expect(stored.bold).toBe(true);
    expect(stored.children).toEqual({ overrideThought: { adornment: 'bullet' } });
    expect(JSON.stringify(stored)).not.toContain('words inside');
    expect(JSON.stringify(stored)).not.toContain('example.test');

    expect(await codec.decrypt(stored, keyLookup)).toEqual(doc);
  });

  test('scalars keep their JSON type through an envelope: numbers and booleans classed content round-trip as numbers and booleans', async () => {
    const userTypePolicy = new LeafPathPolicy({ strings: 'content', nonStrings: 'content' });
    const doc = { systolic: 128, fasting: true, note: 'felt fine', nothing: null };
    const stored = codec.encrypt(doc, userTypePolicy, key) as any;
    for (const field of ['systolic', 'fasting', 'note', 'nothing']) {
      expect(envelope.isEnvelope(stored[field])).toBe(true);
    }
    expect(await codec.decrypt(stored, keyLookup)).toEqual(doc);
  });

  test('a subtree classed content becomes ONE envelope object, never a bare string document', async () => {
    const doc = { a: 1, words: 'x', nested: { deep: [1, 2, 'three'] } };
    const stored = codec.encrypt(doc, WHOLE_VALUE_CONTENT, key) as any;
    expect(Object.keys(stored)).toEqual([ENC]);
    expect(envelope.isEnvelope(stored[ENC])).toBe(true);
    expect(await codec.decrypt(stored, keyLookup)).toEqual(doc);

    // A top-level array arrives wrapped (JsonColumn) and leaves as one envelope object; decrypt returns the array.
    const wrappedArray = { [ARR]: [{ id: 1, text: 'a' }, 'b'] };
    const storedArray = codec.encrypt(wrappedArray, WHOLE_VALUE_CONTENT, key) as any;
    expect(Object.keys(storedArray)).toEqual([ENC]);
    expect(await codec.decrypt(storedArray, keyLookup)).toEqual([{ id: 1, text: 'a' }, 'b']);
  });

  test('ids-skeleton entries: each array entry is one envelope with its id kept plaintext beside it; the array wrapper survives', async () => {
    const sources = { [ARR]: [{ id: 's1', url: 'https://a.test', title: 'A' }, { id: 's2', url: 'https://b.test' }] };
    const stored = codec.encrypt(sources, ID_SKELETON_ENTRIES, key) as any;
    expect(Object.keys(stored)).toEqual([ARR]);
    expect(stored[ARR]).toHaveLength(2);
    expect(stored[ARR][0].id).toBe('s1');
    expect(Object.keys(stored[ARR][0]).sort()).toEqual([ENC, 'id']);
    expect(JSON.stringify(stored)).not.toContain('a.test');

    expect(await codec.decrypt(stored, keyLookup)).toEqual(sources);
  });

  test('decrypt is policy-free and copy-on-hit: mixed plaintext/envelope leaves both come back; a clean value returns the same reference; keys memoize per call', async () => {
    const stored = codec.encrypt({ content: 'secret', type: 'h1', extra: 'more' }, textPolicy, key) as any;
    const mixed = { ...stored, content: 'a plaintext leaf an old writer left' };
    expect(await codec.decrypt(mixed, keyLookup)).toEqual({
      content: 'a plaintext leaf an old writer left',
      type: 'h1',
      extra: 'more',
    });
    expect(lookups).toEqual(['owner-a:1']); // one lookup for the one envelope (memoized per call)

    const clean = { type: 'h1', n: 2, nested: { list: [1, 'x'] } };
    expect(await codec.decrypt(clean, keyLookup)).toBe(clean);
  });

  test('encrypt never double-encrypts: an envelope or subtree envelope already in the input passes through', () => {
    const stored = codec.encrypt({ content: 'once', type: 'h1', blob: { x: 1 } }, new LeafPathPolicy({
      metadata: ['$.type'],
      content: ['$.blob'],
      strings: 'content',
      nonStrings: 'metadata',
    }), key) as any;
    const again = codec.encrypt(stored, textPolicy, key) as any;
    expect(again.content).toBe(stored.content);
    expect(again.blob).toBe(stored.blob);
  });

  test('audit measures a stored document against a policy: plaintext content, envelopes at now-metadata paths, and every envelope with its key', () => {
    // Stored under the DEFAULT rule (every non-platform string is words): `state` is an envelope.
    const defaultPolicy = new LeafPathPolicy({ metadata: ['$.type'], strings: 'content', nonStrings: 'metadata' });
    const stored = codec.encrypt({ content: 'w', state: 'planned', type: 'h1', n: 1 }, defaultPolicy, key) as any;
    // Under a policy that now calls `state` a fact: the state envelope is "enveloped metadata".
    const factPolicy = new LeafPathPolicy({ metadata: ['$.type', '$.state'], strings: 'content', nonStrings: 'metadata' });
    const audit = codec.audit({ ...stored, content: 'plain again' }, factPolicy);
    expect(audit.plaintextContent).toEqual(['$.content']);
    expect(audit.envelopedMetadata).toEqual(['$.state']);
    expect(audit.envelopes).toEqual([{ path: '$.state', owner: 'owner-a', version: 1 }]);

    const converged = codec.audit(codec.encrypt({ content: 'w', state: 'planned', type: 'h1', n: 1 }, factPolicy, key), factPolicy);
    expect(converged.plaintextContent).toEqual([]);
    expect(converged.envelopedMetadata).toEqual([]);
    expect(converged.envelopes.map((e) => e.path)).toEqual(['$.content']);
  });

  test('refuses documents nested deeper than the margin under the Spanner limit', () => {
    let deep: any = 'leaf';
    for (let i = 0; i < LeafEnvelopeCodec.MAX_DEPTH + 2; i++) {
      deep = { d: deep };
    }
    expect(() => codec.encrypt(deep, ALL_STRINGS_CONTENT, key)).toThrow(/nested deeper/);
    expect(ALL_STRINGS_CONTENT.classify('$.anything', 'x')).toBe('content');
  });
});

describe('LeafPath', () => {
  test('format and parse are inverses over members, indexes, and quoted keys', () => {
    const path = LeafPath.format(['content', 'thoughtObject', 0, 'odd key', 'x']);
    expect(path).toBe('$.content.thoughtObject[0]["odd key"].x');
    expect(LeafPath.parse(path)).toEqual(['content', 'thoughtObject', 0, 'odd key', 'x']);
    expect(LeafPath.format([])).toBe('$');
  });

  test('patterns: exact, [*]/.* one segment, .** any run, [n] one index', () => {
    expect(LeafPath.matches('$.type', '$.type')).toBe(true);
    expect(LeafPath.matches('$.type', '$.content.type')).toBe(false);
    expect(LeafPath.matches('$[*].url', '$[3].url')).toBe(true);
    expect(LeafPath.matches('$[*].url', '$.url')).toBe(false);
    expect(LeafPath.matches('$.children.*.adornment', '$.children.overrideThought.adornment')).toBe(true);
    expect(LeafPath.matches('$.children.*.adornment', '$.children.overrideThoughtByType.text.adornment')).toBe(false);
    expect(LeafPath.matches('$.children.**.adornment', '$.children.overrideThoughtByType.text.adornment')).toBe(true);
    expect(LeafPath.matches('$.children.**.adornment', '$.children.adornment')).toBe(true);
    expect(LeafPath.matches('$.**', '$')).toBe(true);
    expect(LeafPath.matches('$[0]', '$[1]')).toBe(false);
    expect(LeafPath.matches('$', '$')).toBe(true);
    expect(LeafPath.matches('$', '$.a')).toBe(false);
  });
});

describe('LeafPathPolicy', () => {
  test('precedence: content patterns beat metadata patterns beat type defaults; objects descend unless named content', () => {
    const policy = new LeafPathPolicy({
      metadata: ['$.type', '$.meta.**'],
      content: ['$.meta.secretNote', '$.blob'],
      contentKeeping: [{ path: '$.entries[*]', keep: ['id'] }],
      strings: 'content',
      nonStrings: 'metadata',
    });
    expect(policy.classify('$.type', 'h1')).toBe('metadata');
    expect(policy.classify('$.meta.kind', 'x')).toBe('metadata');
    expect(policy.classify('$.meta.secretNote', 'x')).toBe('content');
    expect(policy.classify('$.blob', { a: 1 })).toBe('content');
    expect(policy.classify('$.other', { a: 1 })).toBe('metadata'); // descend
    expect(policy.classify('$.other', 'words')).toBe('content');
    expect(policy.classify('$.other', 12)).toBe('metadata');
    expect(policy.classify('$.entries[0]', { id: 'a', url: 'u' })).toEqual({ content: true, keep: ['id'] });
    expect(policy.classify('$.entries[0]', 'not an object')).toBe('content');

    expect(policy.isAlwaysMetadata('$.type')).toBe(true);
    expect(policy.isAlwaysMetadata('$.meta.secretNote')).toBe(false);
    expect(policy.isAlwaysMetadata('$.other')).toBe(false);
  });
});
