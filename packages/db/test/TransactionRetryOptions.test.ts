import { SourceRepository } from '@proteinjs/reflection';
import { Statement } from '@proteinjs/db-query';
import { Db, DbDriver, DbDriverDmlStatementConfig } from '../src/Db';
import { Table } from '../src/Table';
import { Record, withRecordColumns } from '../src/Record';
import { StringColumn } from '../src/Columns';
import { TableWatcherRunner } from '../src/TableWatcherRunner';
import { DefaultTransactionContextFactory, TransactionContextData } from '../src/transaction/TransactionContextFactory';
import { TransactionOptions } from '../src/transaction/TransactionRetryPolicy';
import {
  TransactionRetryExhaustedError,
  isTransactionRetryExhaustedError,
} from '../src/TransactionRetryExhaustedError';

/**
 * The retry policy a caller names at the call reaches the driver on the write's own transaction —
 * `insert` and `update` outside a transaction hand it to `runDml` beside the (absent) transaction,
 * `runTransaction` hands it to the driver's `runTransaction` — and a write inside a transaction
 * naming a policy of its own is refused by name: the transaction's policy governs every write in
 * it, and a policy nothing would honour is never dropped on the floor. What the driver does with
 * the policy — the bounded attempts, the typed refusal — is the driver suites' (the Spanner
 * driver's BoundedTransactionRetry suite, on the emulator); the typed refusal's shape is held
 * here.
 */

interface Doc extends Record {
  title: string;
}

class DocTable extends Table<Doc> {
  public name = 'retry_options_doc';
  public columns = withRecordColumns<Doc>({
    title: new StringColumn('title'),
  });
}

const docTable = new DocTable() as Table<Doc>;

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

/** A driver that records the transaction and options every write and transaction arrived with. */
class RecordingDriver implements DbDriver {
  readonly dmlCalls: { transaction: unknown; options: TransactionOptions | undefined }[] = [];
  readonly transactionCalls: { options: TransactionOptions | undefined }[] = [];

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

  async runDml(
    generateStatement: (config: DbDriverDmlStatementConfig) => Statement,
    transaction?: unknown,
    options?: TransactionOptions
  ): Promise<number> {
    generateStatement({
      useParams: true,
      useNamedParams: true,
      prefixTablesWithDb: false,
      getDriverColumnType: () => 'STRING(MAX)',
    });
    this.dmlCalls.push({ transaction, options });
    return 1;
  }

  async runTransaction<T>(fn: (transaction: unknown) => Promise<T>, options?: TransactionOptions): Promise<T> {
    this.transactionCalls.push({ options });
    return await fn({ handle: 'the transaction' });
  }

  getOperationDeadlineMs(): number {
    return 60_000;
  }
}

type SourceRepositoryInternals = { objectCache: { [qualifiedName: string]: unknown[] } };
type TableWatcherRunnerStatics = { tableWatcherMap?: unknown };
const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;

describe('A write names its retry policy at the call; it reaches the driver on the write`s own transaction', () => {
  let driver: RecordingDriver;
  let db: Db<Doc>;
  let originalWatchers: unknown[] | undefined;

  // No reflection graph in a unit test: the watcher registry is empty by declaration.
  beforeAll(() => {
    originalWatchers = objectCache()['@proteinjs/db/TableWatcher'];
    objectCache()['@proteinjs/db/TableWatcher'] = [];
    (TableWatcherRunner as unknown as TableWatcherRunnerStatics).tableWatcherMap = undefined;
  });

  afterAll(() => {
    if (originalWatchers) {
      objectCache()['@proteinjs/db/TableWatcher'] = originalWatchers;
    } else {
      delete objectCache()['@proteinjs/db/TableWatcher'];
    }
    (TableWatcherRunner as unknown as TableWatcherRunnerStatics).tableWatcherMap = undefined;
  });

  beforeEach(() => {
    driver = new RecordingDriver();
    db = new Db<Doc>(driver, () => docTable, new TestTransactionContextFactory(), true);
  });

  test('an update outside a transaction carries its policy to the driver, with no transaction', async () => {
    await db.update(docTable, { id: 'doc-1', title: 'a title' }, undefined, { retry: { attempts: 2, maxMs: 1500 } });

    expect(driver.dmlCalls).toEqual([{ transaction: undefined, options: { retry: { attempts: 2, maxMs: 1500 } } }]);
  });

  test('an insert outside a transaction carries its policy to the driver, with no transaction', async () => {
    await db.insert(docTable, { title: 'a title' }, { retry: 'none' });

    expect(driver.dmlCalls).toEqual([{ transaction: undefined, options: { retry: 'none' } }]);
  });

  test('a write with no policy reaches the driver with none — the driver`s own road', async () => {
    await db.update(docTable, { id: 'doc-1', title: 'a title' });
    await db.insert(docTable, { title: 'a title' });

    expect(driver.dmlCalls.map((call) => call.options)).toEqual([undefined, undefined]);
  });

  test('a transaction carries its policy to the driver, and the writes inside it ride the transaction with no policy of their own', async () => {
    await db.runTransaction(
      async () => {
        await db.update(docTable, { id: 'doc-1', title: 'a title' });
        await db.insert(docTable, { title: 'a title' });
      },
      { retry: { attempts: 3 } }
    );

    expect(driver.transactionCalls).toEqual([{ options: { retry: { attempts: 3 } } }]);
    expect(driver.dmlCalls).toEqual([
      { transaction: { handle: 'the transaction' }, options: undefined },
      { transaction: { handle: 'the transaction' }, options: undefined },
    ]);
  });

  test('a write inside a transaction naming a policy of its own is refused by name, and never reaches the driver', async () => {
    const refusal = db.runTransaction(async () => {
      await db.update(docTable, { id: 'doc-1', title: 'a title' }, undefined, { retry: 'none' });
    });

    await expect(refusal).rejects.toThrow('A write inside a transaction cannot name a retry policy of its own');
    expect(driver.dmlCalls).toEqual([]);
  });

  test('the typed refusal: name-tagged, carrying the attempts and the elapsed time, its cause never enumerable', () => {
    const abort = new Error('10 ABORTED: the backend quotes a row value here');
    const refusal = new TransactionRetryExhaustedError('spanner dml transaction', 2, 312.4, abort);

    expect(isTransactionRetryExhaustedError(refusal)).toBe(true);
    expect(isTransactionRetryExhaustedError(new Error('other'))).toBe(false);
    expect(refusal.name).toBe('TransactionRetryExhaustedError');
    expect(refusal.attempts).toBe(2);
    expect(refusal.elapsedMs).toBe(312.4);
    expect(refusal.cause).toBe(abort);
    expect(Object.keys(refusal)).not.toContain('cause');
    expect(JSON.stringify(refusal)).not.toContain('row value');
    expect(refusal.message).toBe(
      'Transaction aborted and not retried further: its retry policy allowed 2 attempts, made in 312ms (spanner dml transaction)'
    );
  });
});
