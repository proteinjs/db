import { SourceRepository } from '@proteinjs/reflection';
import { Db, DbDriver } from '../src/Db';
import { Table } from '../src/Table';
import { TableManager } from '../src/schema/TableManager';
import { DefaultTransactionContextFactory, TransactionContextData } from '../src/transaction/TransactionContextFactory';
import { SourceRecordLoadSummary, SourceRecordSync, getSourceRecordSync } from '../src/source/SourceRecordSync';
import { SourceRecordSyncRunner } from '../source/SourceRecordSyncRunner';

/**
 * The seam between a boot and the source-record sync. `Db.init` (and the pre-schema-sync
 * migration phase) run the sync through `getSourceRecordSync()` — reflection's one
 * `@proteinjs/db/SourceRecordSync` — instead of importing the runner: the runner is server-only
 * code behind `@proteinjs/db/source`, kept out of the browser index by
 * test/BrowserIndexNoNodeBuiltins.test.ts. Three pins: a boot with no sync registered refuses,
 * loudly, naming the subpath (never a silent boot without its source records); the subpath's
 * built artifact registers the runner as that one implementation (the server road — exactly what
 * a server's `import '@proteinjs/db/source'` runs); and `Db.init` reaches the registered sync
 * after schema sync, as the whole-build boot (no table named).
 */
type SourceRepositoryInternals = {
  objectCache: { [qualifiedName: string]: unknown[] };
  namedObjectCache: { [qualifiedName: string]: { qualifiedName: string; packageName: string; object: unknown }[] };
};
const QUALIFIED_NAME = '@proteinjs/db/SourceRecordSync';
const internals = () => SourceRepository.get() as unknown as SourceRepositoryInternals;
/** Reflection memoizes each lookup (a refusal caches an empty answer): forget this seam's. */
const forgetLookups = () => {
  delete internals().objectCache[QUALIFIED_NAME];
  delete internals().namedObjectCache[QUALIFIED_NAME];
};

describe('getSourceRecordSync — a boot without the server-only subpath refuses', () => {
  beforeAll(async () => {
    forgetLookups();
    // The package's own entry, as every consumer's `import '@proteinjs/db'` runs it: the seam's
    // interface is in the graph, and nothing implements it until the subpath is imported.
    await import('../generated/index');
  });
  afterAll(forgetLookups);

  it('throws, naming @proteinjs/db/source, when no SourceRecordSync is registered', () => {
    expect(() => getSourceRecordSync()).toThrow(/Unable to find a @proteinjs\/db\/SourceRecordSync implementation/);
    expect(() => getSourceRecordSync()).toThrow(/import '@proteinjs\/db\/source'/);
  });
});

describe('the ./source subpath registers the runner (the server road)', () => {
  beforeAll(async () => {
    forgetLookups();
    // The artifact the build wrote for the subpath — what `import '@proteinjs/db/source'` runs on a server.
    await import('../generated/source');
  });
  afterAll(forgetLookups);

  it('resolves SourceRecordSyncRunner as the one @proteinjs/db/SourceRecordSync', () => {
    expect(getSourceRecordSync()).toBeInstanceOf(SourceRecordSyncRunner);
    expect(SourceRepository.get().objects<SourceRecordSync>(QUALIFIED_NAME)).toHaveLength(1);
  });
});

describe('Db.init runs the registered sync after schema sync (the whole-build boot)', () => {
  /** The boot's legs in the order they ran: schema sync, then the sync with the table it was given. */
  const legs: { leg: 'schema' | 'sync'; onlyTable?: string }[] = [];

  class RecordingSync implements SourceRecordSync {
    async load(onlyTable?: Table<any>): Promise<SourceRecordLoadSummary> {
      legs.push({ leg: 'sync', onlyTable: onlyTable?.name });
      return {};
    }
  }

  /** Accepts the boot's schema leg and records it; no database behind it. */
  class BootDriver implements DbDriver {
    getDbName(): string {
      return 'test';
    }

    async createDbIfNotExists(): Promise<void> {}

    async createDb(): Promise<void> {}

    async dropDb(): Promise<void> {}

    getTableManager(): TableManager {
      return {
        loadTables: async () => {
          legs.push({ leg: 'schema' });
        },
      } as unknown as TableManager;
    }

    async runQuery(): Promise<never[]> {
      return [];
    }

    async runDml(): Promise<number> {
      return 0;
    }

    async runTransaction<T>(fn: (transaction: unknown) => Promise<T>): Promise<T> {
      return await fn({ id: 'transaction' });
    }

    getOperationDeadlineMs(): number {
      return 1000;
    }
  }

  class BootTransactionContextFactory implements DefaultTransactionContextFactory {
    private context: TransactionContextData = {};

    getTransactionContext(): TransactionContextData {
      return this.context;
    }

    async runInContext<T>(context: TransactionContextData, fn: () => Promise<T>): Promise<T> {
      const previous = this.context;
      this.context = context;
      try {
        return await fn();
      } finally {
        this.context = previous;
      }
    }
  }

  beforeAll(() => {
    forgetLookups();
    // Registered the way the subpath's artifact registers the runner: one named SourceRecordSync.
    internals().namedObjectCache[QUALIFIED_NAME] = [
      { qualifiedName: '@test/RecordingSync', packageName: '@test', object: new RecordingSync() },
    ];
  });
  afterAll(forgetLookups);

  it('reaches the sync through the seam, after the schema sync, for the whole build', async () => {
    await new Db(new BootDriver(), undefined, new BootTransactionContextFactory()).init();
    expect(legs).toEqual([{ leg: 'schema' }, { leg: 'sync', onlyTable: undefined }]);
  });
});
