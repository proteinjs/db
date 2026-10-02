import { SourceRepository } from '@proteinjs/reflection';
import { Statement } from '@proteinjs/db-query';
import { Db, DbDriver, DbDriverDmlStatementConfig } from '../src/Db';
import { Table } from '../src/Table';
import { Record, withRecordColumns } from '../src/Record';
import { BooleanColumn, StringColumn } from '../src/Columns';
import { TableWatcher } from '../src/TableWatcher';
import { TableWatcherRunner } from '../src/TableWatcherRunner';
import { DefaultTransactionContextFactory, TransactionContextData } from '../src/transaction/TransactionContextFactory';

/**
 * `Db.insertMany`'s contract against a recording driver (no database): N rows issue ONE statement
 * carrying every row with its defaults; each per-row hook — the before-insert table watcher, the
 * columns' before/after-insert hooks, the after-insert table watcher — fires once per row, in
 * the order given, and sees the row exactly as the single `insert` road shows it; a batch wider
 * than the driver's statement parameter bound splits into the fewest statements that fit; the
 * batch is one transaction (the ambient one, else its own); a refused statement runs no
 * after-phase. What the database does with the statement — every row landing, the rollback of a
 * refused batch — is the drivers' emulator suites' (the reusable CRUD and transaction tests).
 */

interface Doc extends Record {
  title: string;
  note?: string | null;
  flagged?: boolean;
}

type HookEvent = [phase: string, title: string, idPresent: boolean];
const log: HookEvent[] = [];

class DocTable extends Table<Doc> {
  public name = 'insert_many_doc';
  public columns = withRecordColumns<Doc>({
    title: new StringColumn('title', {
      onBeforeInsert: async (_table, record) => {
        log.push(['column.before', record.title, typeof record.id === 'string']);
        record.title = `${record.title}!`;
      },
      onAfterInsert: async (_table, record) => {
        log.push(['column.after', record.title, typeof record.id === 'string']);
      },
    }),
    note: new StringColumn('note'),
    flagged: new BooleanColumn('flagged', { defaultValue: async () => false }),
  });
}

const docTable = new DocTable() as Table<Doc>;

class RecordingWatcher implements TableWatcher<Doc> {
  name(): string {
    return 'RecordingWatcher';
  }

  table(): Table<Doc> {
    return docTable;
  }

  async beforeInsert<T extends Doc>(record: Omit<T, keyof Doc>): Promise<Omit<T, keyof Doc>> {
    const doc = record as unknown as Doc;
    log.push(['watcher.before', doc.title, typeof doc.id === 'string']);
    return { ...record, note: `seen ${doc.title}` };
  }

  async afterInsert<T extends Doc>(record: T): Promise<void> {
    log.push(['watcher.after', record.title, typeof record.id === 'string']);
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

/** Records every DML statement the Db hands it, as the Spanner driver would generate it. */
class RecordingDriver implements DbDriver {
  dml: { sql: string; params: { [name: string]: unknown }; transaction: unknown }[] = [];
  transactions = 0;
  refuse?: (sql: string) => boolean;

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

  async runDml(generateStatement: (config: DbDriverDmlStatementConfig) => Statement, transaction?: unknown) {
    const statement = generateStatement({
      useParams: true,
      useNamedParams: true,
      prefixTablesWithDb: false,
      getDriverColumnType: () => 'STRING(MAX)',
    });
    this.dml.push({ sql: statement.sql, params: statement.namedParams?.params ?? {}, transaction });
    if (this.refuse?.(statement.sql)) {
      throw new Error(`refused: ${statement.sql}`);
    }
    return tuplesOf(statement.sql);
  }

  async runTransaction<T>(fn: (transaction: unknown) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return await fn({ id: `transaction-${this.transactions}` });
  }

  getOperationDeadlineMs(): number {
    return 1000;
  }
}

class BoundedDriver extends RecordingDriver {
  constructor(private readonly limit: number) {
    super();
  }

  getStatementParameterLimit(): number {
    return this.limit;
  }
}

const tuplesOf = (sql: string): number => (sql.match(/\(@param\d+/g) ?? []).length;

type SourceRepositoryInternals = { objectCache: { [qualifiedName: string]: unknown[] } };
type TableWatcherRunnerStatics = { tableWatcherMap?: unknown };
const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;

/** A system Db over `driver`, its watcher map rebuilt from the recording watcher alone. */
const dbOver = (driver: DbDriver): Db<Doc> => {
  (TableWatcherRunner as unknown as TableWatcherRunnerStatics).tableWatcherMap = undefined;
  return new Db<Doc>(driver, () => docTable, new TestTransactionContextFactory(), true);
};

const rowsOf = (titles: string[]): Omit<Doc, keyof Record>[] => titles.map((title) => ({ title }));
const eventsFor = (title: string) => log.filter(([, t]) => t === title || t === `${title}!`);
const shapeOf = (doc: Doc) => ({ title: doc.title, note: doc.note, flagged: doc.flagged });

describe('Db.insertMany', () => {
  let originalWatchers: unknown[] | undefined;

  beforeAll(() => {
    originalWatchers = objectCache()['@proteinjs/db/TableWatcher'];
    objectCache()['@proteinjs/db/TableWatcher'] = [new RecordingWatcher()];
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
    log.length = 0;
  });

  test('N rows issue exactly ONE statement, every row in it with its defaults, returned in order', async () => {
    const driver = new RecordingDriver();
    const db = dbOver(driver);

    const inserted = await db.insertMany(docTable, rowsOf(['a', 'b', 'c']));

    expect(driver.dml).toHaveLength(1);
    expect(tuplesOf(driver.dml[0].sql)).toBe(3);
    expect(driver.dml[0].sql).toMatch(/^INSERT INTO `insert_many_doc` \(.+\) VALUES \(.+\), \(.+\), \(.+\);$/);
    expect(inserted.map(shapeOf)).toEqual([
      { title: 'a!', note: 'seen a', flagged: false },
      { title: 'b!', note: 'seen b', flagged: false },
      { title: 'c!', note: 'seen c', flagged: false },
    ]);
    for (const doc of inserted) {
      expect(typeof doc.id).toBe('string');
      expect(doc.created).toBeDefined();
      expect(doc.updated).toBeDefined();
    }
    // The statement carries what the rows carry: the ids the defaults set and the watcher's note.
    const bound = Object.values(driver.dml[0].params);
    for (const doc of inserted) {
      expect(bound).toContain(doc.id);
      expect(bound).toContain(doc.note);
    }
  });

  test('every per-row hook fires once per row, in row order, and sees the row as the single insert shows it', async () => {
    const serial = dbOver(new RecordingDriver());
    for (const row of rowsOf(['a', 'b'])) {
      await serial.insert(docTable, row);
    }
    const serialLog = [...log];
    log.length = 0;

    const batched = dbOver(new RecordingDriver());
    await batched.insertMany(docTable, rowsOf(['a', 'b']));

    // Each row's own sequence — what fired, in what order, with the id already set — is the
    // serial road's exactly.
    for (const title of ['a', 'b']) {
      const serialEvents = serialLog.filter(([, t]) => t === title || t === `${title}!`);
      expect(eventsFor(title)).toEqual(serialEvents);
      expect(eventsFor(title).map(([phase]) => phase)).toEqual([
        'watcher.before',
        'column.before',
        'column.after',
        'watcher.after',
      ]);
    }
    // Across rows, each phase runs in row order; the before-phases of every row precede the
    // statement, the after-phases follow it.
    expect(log.map(([phase, title]) => `${phase}:${title}`)).toEqual([
      'watcher.before:a',
      'column.before:a',
      'watcher.before:b',
      'column.before:b',
      'column.after:a!',
      'watcher.after:a!',
      'column.after:b!',
      'watcher.after:b!',
    ]);
  });

  test("a batch wider than the driver's parameter bound goes as the fewest statements that fit, in order", async () => {
    // Six columns per row (id, created, updated, title, note, flagged); a bound of 13 admits two rows a statement.
    const driver = new BoundedDriver(13);
    const db = dbOver(driver);

    const inserted = await db.insertMany(docTable, rowsOf(['a', 'b', 'c', 'd', 'e']));

    expect(driver.dml.map((statement) => tuplesOf(statement.sql))).toEqual([2, 2, 1]);
    for (const statement of driver.dml) {
      expect(Object.keys(statement.params).length).toBeLessThanOrEqual(13);
    }
    expect(inserted.map((doc) => doc.title)).toEqual(['a!', 'b!', 'c!', 'd!', 'e!']);
    // One transaction around the whole batch: every statement rides the same one.
    expect(driver.transactions).toBe(1);
    expect(new Set(driver.dml.map((statement) => statement.transaction)).size).toBe(1);
  });

  test('the batch rides the ambient transaction when there is one, and opens its own when there is none', async () => {
    const ambient = new RecordingDriver();
    const db = dbOver(ambient);
    await db.runTransaction(async () => {
      await db.insertMany(docTable, rowsOf(['a', 'b']));
    });
    expect(ambient.transactions).toBe(1);
    expect(ambient.dml[0].transaction).toEqual({ id: 'transaction-1' });

    const own = new RecordingDriver();
    await dbOver(own).insertMany(docTable, rowsOf(['a', 'b']));
    expect(own.transactions).toBe(1);
    expect(own.dml[0].transaction).toEqual({ id: 'transaction-1' });
  });

  test('no rows: nothing issued, nothing opened, an empty result', async () => {
    const driver = new RecordingDriver();
    const inserted = await dbOver(driver).insertMany(docTable, []);

    expect(inserted).toEqual([]);
    expect(driver.dml).toHaveLength(0);
    expect(driver.transactions).toBe(0);
    expect(log).toHaveLength(0);
  });

  test('a refused statement fails the batch: the error surfaces and no after-phase runs for any row', async () => {
    const driver = new RecordingDriver();
    driver.refuse = () => true;

    await expect(dbOver(driver).insertMany(docTable, rowsOf(['a', 'b']))).rejects.toThrow('refused');

    expect(driver.dml).toHaveLength(1);
    expect(log.map(([phase]) => phase).filter((phase) => phase.endsWith('.after'))).toEqual([]);
  });
});
