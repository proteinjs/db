import { SourceRecordLoader } from '../src/source/SourceRecordLoader';

/**
 * Covers the two helpers that drive SourceRecordLoader's change-detection:
 * - `canonicalStringify`: deterministic, key-order-independent JSON
 * - `findMismatchPath`: per-field drift detection that uses canonical stringify
 *   so object-valued columns (e.g. `JsonColumn`) are compared strictly while
 *   remaining immune to storage-side key reordering (Spanner alphabetizes JSON
 *   object keys on write).
 *
 * Both are private methods on `SourceRecordLoader`. Tests access them through
 * the instance with a cast — cheaper than wiring full `hasChanges` fixtures
 * (Table, RecordSerializer, Db) and keeps the public API surface of the class
 * unchanged.
 */

type LoaderInternals = {
  canonicalStringify: (value: unknown) => string;
  findMismatchPath: (source: any, existing: any, path: string) => string | null;
};

const internals = () => new SourceRecordLoader() as unknown as LoaderInternals;

describe('SourceRecordLoader.canonicalStringify', () => {
  it('produces the same string for objects with different key orders', () => {
    const loader = internals();
    const a = { foo: 1, bar: 2, baz: 3 };
    const b = { baz: 3, foo: 1, bar: 2 };
    expect(loader.canonicalStringify(a)).toBe(loader.canonicalStringify(b));
  });

  it('sorts keys alphabetically in nested objects', () => {
    const loader = internals();
    const value = { z: { c: 1, a: 2, b: 3 }, a: 1 };
    expect(loader.canonicalStringify(value)).toBe('{"a":1,"z":{"a":2,"b":3,"c":1}}');
  });

  it('preserves array order (arrays are semantically ordered)', () => {
    const loader = internals();
    expect(loader.canonicalStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles primitives the same as JSON.stringify', () => {
    const loader = internals();
    expect(loader.canonicalStringify('hello')).toBe('"hello"');
    expect(loader.canonicalStringify(42)).toBe('42');
    expect(loader.canonicalStringify(true)).toBe('true');
    expect(loader.canonicalStringify(null)).toBe('null');
  });
});

describe('SourceRecordLoader.findMismatchPath', () => {
  describe('object comparison', () => {
    it('returns null for identical objects', () => {
      const loader = internals();
      const source = { content: '', type: 'body1', linkedThoughtId: '' };
      const existing = { content: '', type: 'body1', linkedThoughtId: '' };
      expect(loader.findMismatchPath(source, existing, 'newThoughtTemplate')).toBeNull();
    });

    it('returns null when existing has the same keys in a different order (Spanner alphabetizes)', () => {
      // This is the critical case: Spanner canonicalizes JSON object keys
      // alphabetically on storage. Source declared in TypeScript doesn't
      // guarantee alphabetical key order. The two must still compare equal.
      const loader = internals();
      const source = { content: '', type: 'body1', linkedThoughtId: '' };
      const existing = { content: '', linkedThoughtId: '', type: 'body1' };
      expect(loader.findMismatchPath(source, existing, 'newThoughtTemplate')).toBeNull();
    });

    it('reports a mismatch when existing has extra keys (ThoughtLink drift case)', () => {
      // Regression guard for the bug that prompted this change: source was
      // simplified to drop TextType drift keys (fontSize, bold, italic, etc.),
      // but the old "extras tolerated" behavior left the stale keys on the DB
      // row, causing type-switch demotion to persist.
      const loader = internals();
      const source = {
        thoughtType: { object: { content: '', type: 'body1', linkedThoughtId: '' } },
      };
      const existing = {
        thoughtType: {
          object: {
            content: '',
            type: 'body1',
            linkedThoughtId: '',
            fontSize: 14,
            bold: false,
            italic: false,
          },
        },
      };
      expect(loader.findMismatchPath(source, existing, 'newThoughtTemplate')).not.toBeNull();
    });

    it('reports a mismatch when existing is missing a key present in source', () => {
      const loader = internals();
      const source = { content: '', type: 'body1', linkedThoughtId: '' };
      const existing = { content: '', type: 'body1' };
      expect(loader.findMismatchPath(source, existing, 'newThoughtTemplate')).not.toBeNull();
    });

    it('reports a mismatch for a nested value difference', () => {
      const loader = internals();
      const source = { thoughtType: { object: { type: 'body1' } } };
      const existing = { thoughtType: { object: { type: 'body2' } } };
      expect(loader.findMismatchPath(source, existing, 'newThoughtTemplate')).not.toBeNull();
    });

    it('treats source-side undefined values as equivalent to missing in existing', () => {
      // `JSON.stringify` drops undefined values, so the DB cannot store them
      // in the first place. Source declaring an undefined field must not be
      // treated as drift vs an existing row that lacks the field.
      const loader = internals();
      const source = { content: 'hi', optional: undefined };
      const existing = { content: 'hi' };
      expect(loader.findMismatchPath(source, existing, 'newThoughtTemplate')).toBeNull();
    });
  });

  describe('array comparison', () => {
    it('reports a mismatch on array length', () => {
      const loader = internals();
      expect(loader.findMismatchPath([1, 2], [1, 2, 3], 'tags')).not.toBeNull();
    });

    it('reports a mismatch on array element difference', () => {
      const loader = internals();
      expect(loader.findMismatchPath([1, 2], [1, 3], 'tags')).not.toBeNull();
    });

    it('returns null for equal arrays', () => {
      const loader = internals();
      expect(loader.findMismatchPath([1, 2, 3], [1, 2, 3], 'tags')).toBeNull();
    });
  });

  describe('primitive comparison', () => {
    it('returns null for equal primitives', () => {
      const loader = internals();
      expect(loader.findMismatchPath('x', 'x', 'name')).toBeNull();
      expect(loader.findMismatchPath(5, 5, 'count')).toBeNull();
    });

    it('reports a mismatch for different primitives', () => {
      const loader = internals();
      expect(loader.findMismatchPath('x', 'y', 'name')).not.toBeNull();
    });

    it('reports a mismatch for type differences', () => {
      const loader = internals();
      expect(loader.findMismatchPath('1', 1, 'value')).not.toBeNull();
    });
  });
});

/**
 * Stamp hygiene on the real migration-ledger shape: `hasChanges` decides whether a boot
 * rewrites a row (bumping `updated`). The ownership stamps ride the declared record, so the
 * comparison must know which of them mean "the definition changed" and which are bookkeeping.
 */
describe('SourceRecordLoader.hasChanges — stamp hygiene on the migration ledger', () => {
  type HasChangesInternals = { hasChanges: (table: any, source: any, existing: any) => Promise<boolean> };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MigrationTable } = require('../src/tables/MigrationTable');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const moment = require('moment');
  const loader = () => new SourceRecordLoader() as unknown as HasChangesInternals;
  const table = new MigrationTable();

  /** What a build declares for a migration (the run function rides along, as it does at boot). */
  const declared = (overrides: Record<string, unknown> = {}) => ({
    id: 'bee7a15c-369f-4e77-abf7-ccd5dc3ae60c',
    description: 'Marks every existing account onboarded',
    run: async () => undefined,
    isLoadedFromSource: true,
    sourcePackage: '@n3xa/app-server',
    sourcePackageVersion: '1.24.0',
    ...overrides,
  });

  /** The ledger row a previous release wrote and later ran. */
  const stored = (overrides: Record<string, unknown> = {}) => ({
    id: 'bee7a15c-369f-4e77-abf7-ccd5dc3ae60c',
    description: 'Marks every existing account onboarded',
    isLoadedFromSource: true,
    sourcePackage: '@n3xa/app-server',
    sourcePackageVersion: '1.23.0',
    status: 'success',
    startTime: moment('2026-08-30T10:00:00Z'),
    endTime: moment('2026-08-30T10:00:02Z'),
    duration: '2 secs',
    output: { rowsInserted: 12 },
    created: moment('2026-08-30T09:00:00Z'),
    updated: moment('2026-08-30T10:00:02Z'),
    ...overrides,
  });

  it('a newer package version alone is NOT a change — the every-release re-stamp', async () => {
    expect(await loader().hasChanges(table, declared(), stored())).toBe(false);
  });

  it('a row with no version stamp gets one (once)', async () => {
    const unstamped = stored();
    delete (unstamped as Partial<typeof unstamped>).sourcePackageVersion;
    expect(await loader().hasChanges(table, declared(), unstamped)).toBe(true);
  });

  it('a redefined description is still a change', async () => {
    expect(await loader().hasChanges(table, declared({ description: 'Reworded' }), stored())).toBe(true);
  });

  it('ledger-owned run state (status, times, output) never reads as drift', async () => {
    expect(await loader().hasChanges(table, declared({ sourcePackageVersion: '1.23.0' }), stored())).toBe(false);
  });
});

describe('getSourceRecordLoaders — declaration identity', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SourceRepository } = require('@proteinjs/reflection');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getSourceRecordLoaders } = require('../src/source/SourceRecord');
  const namedObjectCache = () => (SourceRepository.get() as any).namedObjectCache;

  afterEach(() => {
    delete namedObjectCache()['@proteinjs/db/SourceRecordLoader'];
  });

  it("carries the declaration's own name (the loader class) beside its package and qualified name", () => {
    namedObjectCache()['@proteinjs/db/SourceRecordLoader'] = [
      {
        qualifiedName: '@n3xa/app-server/BackfillOnboardingStateForExistingAccounts',
        packageName: '@n3xa/app-server',
        object: { table: {}, record: {} },
      },
    ];

    const [declaration] = getSourceRecordLoaders() as any[];
    expect(declaration).toMatchObject({
      source: '@n3xa/app-server',
      qualifiedName: '@n3xa/app-server/BackfillOnboardingStateForExistingAccounts',
      name: 'BackfillOnboardingStateForExistingAccounts',
    });
  });
});
