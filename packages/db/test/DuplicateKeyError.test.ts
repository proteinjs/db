import { SourceRepository } from '@proteinjs/reflection';
import { Statement } from '@proteinjs/db-query';
import { Db, DbDriver, DbDriverDmlStatementConfig } from '../src/Db';
import { DuplicateKeyError, isDuplicateKeyError } from '../src/DuplicateKeyError';
import { Table } from '../src/Table';
import { Record, withRecordColumns } from '../src/Record';
import { StringColumn } from '../src/Columns';
import { TableWatcherRunner } from '../src/TableWatcherRunner';
import { DefaultTransactionContextFactory, TransactionContextData } from '../src/transaction/TransactionContextFactory';

/**
 * What an insert's refusal becomes for the caller: a refusal the driver classifies as a duplicate
 * key (a row with the same key already there — the primary key or a unique index) reaches the
 * caller as the typed `DuplicateKeyError`, name-tagged, naming the table and carrying the driver's
 * error as a cause that never prints; every other failure, and every failure on a driver that
 * declares no classifier, reaches the caller exactly as the driver threw it. The same on
 * `insertMany`. What the database itself refuses is the drivers' emulator suites' (the settings
 * package's one-row-per-name suite proves the unique index's refusal end to end).
 */

interface Doc extends Record {
  title: string;
}

class DocTable extends Table<Doc> {
  public name = 'duplicate_key_doc';
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

/** A driver whose every DML fails with the error it is handed, classifying `code === 6` as a duplicate key. */
class RefusingDriver implements DbDriver {
  constructor(private readonly refusal: unknown) {}

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
    throw this.refusal;
  }

  async runTransaction<T>(fn: (transaction: unknown) => Promise<T>): Promise<T> {
    return await fn({ id: 'transaction' });
  }

  getOperationDeadlineMs(): number {
    return 1000;
  }

  isDuplicateKeyError(error: unknown): boolean {
    return (error as { code?: unknown } | null | undefined)?.code === 6;
  }
}

/** The same driver with no classifier declared. */
class UnclassifyingDriver extends RefusingDriver {
  isDuplicateKeyError = undefined as unknown as (error: unknown) => boolean;
}

const dbOn = (driver: DbDriver) => new Db(driver, () => docTable, new TestTransactionContextFactory(), true);

const failureOf = async (act: () => Promise<unknown>): Promise<unknown> => {
  try {
    await act();
  } catch (error) {
    return error;
  }
  throw new Error('the insert was expected to fail');
};

type SourceRepositoryInternals = { objectCache: { [qualifiedName: string]: unknown[] } };
type TableWatcherRunnerStatics = { tableWatcherMap?: unknown };
const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;

describe('an insert the database refuses because the row is already there', () => {
  const backendRefusal = Object.assign(new Error('Row {pk#id:"7f3"} in table duplicate_key_doc already exists'), {
    code: 6,
  });
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

  test('reaches the caller as the typed DuplicateKeyError, naming the table, carrying the cause unprinted', async () => {
    const failure = await failureOf(() => dbOn(new RefusingDriver(backendRefusal)).insert(docTable, { title: 'a' }));
    expect(isDuplicateKeyError(failure)).toBe(true);
    const typed = failure as DuplicateKeyError;
    expect(typed.name).toBe('DuplicateKeyError');
    expect(typed.message).toBe('(duplicate_key_doc) Insert refused: a row with the same key already exists');
    expect(typed.cause).toBe(backendRefusal);
    // The backend's words quote the colliding key: they ride for callers in process only.
    expect(Object.keys(typed)).not.toContain('cause');
    expect(JSON.stringify(typed)).not.toContain('pk#id');
  });

  test('the same on insertMany', async () => {
    const failure = await failureOf(() =>
      dbOn(new RefusingDriver(backendRefusal)).insertMany(docTable, [{ title: 'a' }, { title: 'b' }])
    );
    expect(isDuplicateKeyError(failure)).toBe(true);
    expect((failure as DuplicateKeyError).cause).toBe(backendRefusal);
  });

  test('any other refusal reaches the caller as the driver threw it', async () => {
    const aborted = Object.assign(new Error('Transaction was aborted'), { code: 10 });
    const failure = await failureOf(() => dbOn(new RefusingDriver(aborted)).insert(docTable, { title: 'a' }));
    expect(failure).toBe(aborted);
    expect(isDuplicateKeyError(failure)).toBe(false);
  });

  test('a driver that declares no classifier lets the refusal through as it came', async () => {
    const failure = await failureOf(() =>
      dbOn(new UnclassifyingDriver(backendRefusal)).insert(docTable, { title: 'a' })
    );
    expect(failure).toBe(backendRefusal);
  });

  test('the guard reads the name, not the prototype chain', () => {
    expect(isDuplicateKeyError(Object.assign(new Error('x'), { name: 'DuplicateKeyError' }))).toBe(true);
    expect(isDuplicateKeyError(new Error('DuplicateKeyError'))).toBe(false);
    expect(isDuplicateKeyError(undefined)).toBe(false);
    expect(isDuplicateKeyError('DuplicateKeyError')).toBe(false);
  });
});
