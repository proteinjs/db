import { SourceRepository } from '@proteinjs/reflection';
import { Statement } from '@proteinjs/db-query';
import { Db, DbDriver, DbDriverDmlStatementConfig, getDb, getDbAsSystem } from '../src/Db';
import { Table } from '../src/Table';
import { Record, withRecordColumns } from '../src/Record';
import { StringColumn } from '../src/Columns';
import { TableWatcher } from '../src/TableWatcher';
import { TableWatcherRunner } from '../src/TableWatcherRunner';
import { DefaultTransactionContextFactory, TransactionContextData } from '../src/transaction/TransactionContextFactory';

/**
 * `Db.isSystem()` — the public read of a write's MODE. A hook that must tell a user's write from
 * the system's (a watcher that archives on a user's delete and stands aside on a purge) reads it
 * off the Db the write hands it, instead of guessing from the session. Pinned both ways on the
 * public factories, and — the pin that matters — on the Db the hook runner hands each watcher:
 * that Db answers for the INVOKING write, whatever the session holds.
 */

interface Doc extends Record {
  title: string;
}

class DocTable extends Table<Doc> {
  public name = 'is_system_doc';
  /** Every door open to everyone: a session Db reaches the write with no user to resolve. */
  public auth: Table<Doc>['auth'] = { db: { all: 'public' } };
  public columns = withRecordColumns<Doc>({
    title: new StringColumn('title'),
  });
}

const docTable = new DocTable() as Table<Doc>;

/** What each hook was handed: the mode of its trailing Db. */
const handed: { phase: string; mode: boolean | undefined }[] = [];

class ModeRecordingWatcher implements TableWatcher<Doc> {
  name(): string {
    return 'ModeRecordingWatcher';
  }

  table(): Table<Doc> {
    return docTable;
  }

  async beforeInsert<T extends Doc>(record: Omit<T, keyof Doc>, db?: Db): Promise<Omit<T, keyof Doc>> {
    handed.push({ phase: 'beforeInsert', mode: db?.isSystem() });
    return record;
  }

  async afterInsert<T extends Doc>(_record: T, db?: Db): Promise<void> {
    handed.push({ phase: 'afterInsert', mode: db?.isSystem() });
  }
}

class TestTransactionContextFactory implements DefaultTransactionContextFactory {
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

/** Accepts every statement; no database behind it. */
class AcceptingDriver implements DbDriver {
  getDbName(): string {
    return 'test';
  }

  async createDbIfNotExists(): Promise<void> {}

  async createDb(): Promise<void> {}

  async dropDb(): Promise<void> {}

  getTableManager(): never {
    throw new Error('not used by these tests');
  }

  async runQuery(): Promise<never[]> {
    return [];
  }

  async runDml(generateStatement: (config: DbDriverDmlStatementConfig) => Statement): Promise<number> {
    generateStatement({
      useParams: true,
      useNamedParams: true,
      prefixTablesWithDb: false,
      getDriverColumnType: () => 'STRING(MAX)',
    });
    return 1;
  }

  async runTransaction<T>(fn: (transaction: unknown) => Promise<T>): Promise<T> {
    return await fn({ id: 'transaction' });
  }

  getOperationDeadlineMs(): number {
    return 1000;
  }
}

type SourceRepositoryInternals = { objectCache: { [qualifiedName: string]: unknown[] } };
type TableWatcherRunnerStatics = { tableWatcherMap?: unknown };
const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;
const DEFAULT_DRIVER_GLOBAL = '__proteinjs_db_defaultDbDriver';

const driver = new AcceptingDriver();
const transactions = new TestTransactionContextFactory();
const modesHandedBy = async (db: Db<Doc>): Promise<(boolean | undefined)[]> => {
  handed.length = 0;
  await db.insert(docTable, { title: 'row' });
  expect(handed.map(({ phase }) => phase)).toEqual(['beforeInsert', 'afterInsert']);
  return handed.map(({ mode }) => mode);
};

describe('Db.isSystem', () => {
  let originalWatchers: unknown[] | undefined;
  let originalFactories: unknown[] | undefined;
  let originalTransactionFactories: unknown[] | undefined;

  beforeAll(() => {
    originalWatchers = objectCache()['@proteinjs/db/TableWatcher'];
    originalFactories = objectCache()['@proteinjs/db/DefaultDbDriverFactory'];
    originalTransactionFactories = objectCache()['@proteinjs/db/DefaultTransactionContextFactory'];
    objectCache()['@proteinjs/db/TableWatcher'] = [new ModeRecordingWatcher()];
    // The public factories resolve their driver and transaction context through reflection.
    objectCache()['@proteinjs/db/DefaultDbDriverFactory'] = [{ getDbDriver: () => driver }];
    objectCache()['@proteinjs/db/DefaultTransactionContextFactory'] = [transactions];
    delete (globalThis as { [key: string]: unknown })[DEFAULT_DRIVER_GLOBAL];
    (TableWatcherRunner as unknown as TableWatcherRunnerStatics).tableWatcherMap = undefined;
  });

  afterAll(() => {
    const restore = (name: string, original: unknown[] | undefined) => {
      if (original) {
        objectCache()[name] = original;
      } else {
        delete objectCache()[name];
      }
    };
    restore('@proteinjs/db/TableWatcher', originalWatchers);
    restore('@proteinjs/db/DefaultDbDriverFactory', originalFactories);
    restore('@proteinjs/db/DefaultTransactionContextFactory', originalTransactionFactories);
    delete (globalThis as { [key: string]: unknown })[DEFAULT_DRIVER_GLOBAL];
    (TableWatcherRunner as unknown as TableWatcherRunnerStatics).tableWatcherMap = undefined;
  });

  test('a system Db answers true, a session Db false — on the public factories and on the constructor', () => {
    expect(getDbAsSystem().isSystem()).toBe(true);
    expect(getDb().isSystem()).toBe(false);
    expect(new Db<Doc>(driver, () => docTable, transactions, true).isSystem()).toBe(true);
    expect(new Db<Doc>(driver, () => docTable, transactions).isSystem()).toBe(false);
  });

  test("the Db a write hands its watchers answers for THAT write: a system write's hooks read true", async () => {
    expect(await modesHandedBy(getDbAsSystem<Doc>())).toEqual([true, true]);
  });

  test("the Db a write hands its watchers answers for THAT write: a session write's hooks read false", async () => {
    expect(await modesHandedBy(getDb<Doc>())).toEqual([false, false]);
  });
});
