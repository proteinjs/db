import { randomBytes } from 'crypto';
import { EncryptionEnvelope } from '../src/encryption/EncryptionEnvelope';
import { DataKeyMaterial } from '../src/encryption/DataKeyStore';
import { InMemoryMasterKeyProvider } from '../src/encryption/InMemoryMasterKeyProvider';

const keyFor = (owner: string, version = 1): DataKeyMaterial => ({
  owner,
  version,
  cipherKey: randomBytes(32),
  indexKey: randomBytes(32),
});

describe('EncryptionEnvelope', () => {
  const envelope = new EncryptionEnvelope();

  test('round trip: encrypt -> parse -> decrypt restores the exact plaintext', () => {
    const key = keyFor('11111111-2222-3333-4444-555555555555', 3);
    const plaintext = 'Therapy notes — divorce; emoji 🙂 and unicode ünïcode';
    const stored = envelope.encrypt(plaintext, key);
    expect(stored.startsWith(EncryptionEnvelope.PREFIX)).toBe(true);
    expect(stored).not.toContain('Therapy');

    const parsed = envelope.parse(stored)!;
    expect(parsed.owner).toBe(key.owner);
    expect(parsed.version).toBe(3);
    expect(envelope.decrypt(stored, key)).toBe(plaintext);
  });

  test('self-describing: the envelope names key owner and version (rotation is a rewrite, not a redesign)', () => {
    const key = keyFor('owner-a', 7);
    const parsed = envelope.parse(envelope.encrypt('x', key))!;
    expect(parsed).toMatchObject({ owner: 'owner-a', version: 7 });
  });

  test('plaintext and non-envelope strings do not parse as envelopes', () => {
    expect(envelope.parse('an ordinary title')).toBeUndefined();
    expect(envelope.parse('pjenc:1:not-an-envelope')).toBeUndefined();
    expect(envelope.parse(null)).toBeUndefined();
    expect(envelope.parse(42)).toBeUndefined();
  });

  test('tampered ciphertext fails loudly (GCM auth)', () => {
    const key = keyFor('owner-a');
    const stored = envelope.encrypt('sensitive', key);
    const flipped = stored.slice(0, -2) + (stored.endsWith('AA') ? 'BB' : 'AA');
    expect(() => envelope.decrypt(flipped, key)).toThrow();
  });

  test('wrong key fails loudly, never returns garbage', () => {
    const stored = envelope.encrypt('sensitive', keyFor('owner-a'));
    expect(() => envelope.decrypt(stored, keyFor('owner-a'))).toThrow();
  });
});

describe('InMemoryMasterKeyProvider', () => {
  test('wrap/unwrap round trip; same secret unwraps across instances; wrong secret fails', async () => {
    const material = randomBytes(64);
    const wrapped = await new InMemoryMasterKeyProvider('test-secret').wrapDataKey(material);
    expect(wrapped).not.toContain(material.toString('base64'));

    const unwrapped = await new InMemoryMasterKeyProvider('test-secret').unwrapDataKey(wrapped);
    expect(unwrapped.equals(material)).toBe(true);

    await expect(new InMemoryMasterKeyProvider('other-secret').unwrapDataKey(wrapped)).rejects.toThrow();
  });
});
