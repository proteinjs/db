import { SourceRepository } from '@proteinjs/reflection';
import { Db, DbDriver } from '../src/Db';
import { TableWatcherRunner } from '../src/TableWatcherRunner';
import { Column, Table } from '../src/Table';
import { Record, RecordSerializer, SerializedRecord, withRecordColumns } from '../src/Record';
import { ArrayColumn, ObjectColumn, StringColumn } from '../src/Columns';
import { DefaultTransactionContextFactory, TransactionContextData } from '../src/transaction/TransactionContextFactory';

/**
 * A stored cell a column cannot deserialize — a legacy value written outside the serializer, say a
 * bare word in a column that stores JSON — never takes the row, the result set or the process with
 * it. The law the per-row hydration held (`try { deserialize } catch { omit }`) and the one-pass
 * hydration dropped: the field is OMITTED from the record, every other field lands, the query's
 * promise resolves, and ONE warning per table and column per process names the table, the column
 * and the first row seen — never the stored value (the parser's own message quotes it).
 */

interface Doc extends Record {
  title: string;
  tags: string[];
  settings: { theme: string };
  after: string;
}

class DocTable extends Table<Doc> {
  public name = 'legacy_cell_doc';
  public columns = withRecordColumns<Doc>({
    title: new StringColumn('title'),
    tags: new ArrayColumn<string>('tag_list'),
    settings: new ObjectColumn<{ theme: string }>('settings'),
    after: new StringColumn('after'),
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

/** A driver that answers every query with the rows it was handed — the stored cells as the database holds them. */
class RowsDriver implements DbDriver {
  constructor(private readonly rows: SerializedRecord[]) {}

  getDbName(): string {
    return 'test';
  }

  async createDbIfNotExists(): Promise<void> {}

  async createDb(): Promise<void> {}

  async dropDb(): Promise<void> {}

  getTableManager(): never {
    throw new Error('not used by these tests');
  }

  async runQuery(): Promise<SerializedRecord[]> {
    return this.rows;
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

const dbOver = (table: Table<any>, rows: SerializedRecord[]) =>
  new Db(new RowsDriver(rows), () => table, new TestTransactionContextFactory(), true);

const storedRow = (id: string, cells: Partial<SerializedRecord>): SerializedRecord => ({
  id,
  created: new Date(1_700_000_000_000),
  updated: new Date(1_700_000_000_000),
  title: `title ${id}`,
  tag_list: '["a","b"]',
  settings: '{"theme":"dark"}',
  after: `after ${id}`,
  ...cells,
});

/** The stored value no warning may ever carry — distinctive, so a leak is unmistakable. */
const LEGACY_WORD = 'legacyword7';

type SourceRepositoryInternals = { objectCache: { [qualifiedName: string]: unknown[] } };
type TableWatcherRunnerStatics = { tableWatcherMap?: unknown };
type SerializerInternals = { logger: { warn: (...args: unknown[]) => void; debug: (...args: unknown[]) => void } };
/** The process-wide once-per-table-and-column registry behind the warning (reset per test). */
type SerializerStatics = { legacyCellsWarned: Set<string> };
const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;
let originalWatchers: unknown[] | undefined;

beforeEach(() => {
  (RecordSerializer as unknown as SerializerStatics).legacyCellsWarned?.clear();
});

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

/** Every warning a serializer logs, as the logger received it. */
const warningsOf = (serializer: RecordSerializer<any>): unknown[][] => {
  const calls: unknown[][] = [];
  const logger = (serializer as unknown as SerializerInternals).logger;
  logger.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  return calls;
};

describe('a stored cell a column cannot deserialize', () => {
  it('a query over a row holding a legacy value resolves: the field is omitted, every other field lands', async () => {
    const rows = [storedRow('r1', {}), storedRow('r2', { tag_list: LEGACY_WORD }), storedRow('r3', {})];

    const records = await dbOver(docTable, rows).query(docTable, {});

    expect(records.map((record) => record.id)).toEqual(['r1', 'r2', 'r3']);
    expect(records[0].tags).toEqual(['a', 'b']);
    expect(records[2].tags).toEqual(['a', 'b']);
    expect(records[1]).not.toHaveProperty('tags');
    expect(records[1]).toMatchObject({
      id: 'r2',
      title: 'title r2',
      settings: { theme: 'dark' },
      after: 'after r2',
    });
  });

  it('a get of the row answers the record, not a rejection', async () => {
    const rows = [storedRow('r2', { settings: LEGACY_WORD })];

    const record = await dbOver(docTable, rows).get(docTable, { id: 'r2' });

    expect(record).toMatchObject({ id: 'r2', title: 'title r2', tags: ['a', 'b'], after: 'after r2' });
    expect(record).not.toHaveProperty('settings');
  });

  it('warns once per table and column per process, naming the table, the column and the first row — never the value', () => {
    const serializer = new RecordSerializer<Doc>(docTable);
    const warnings = warningsOf(serializer);
    const rows = [
      storedRow('r1', { tag_list: LEGACY_WORD }),
      storedRow('r2', { tag_list: LEGACY_WORD }),
      storedRow('r3', { settings: LEGACY_WORD }),
    ];

    const records = serializer.deserializeAll(rows) as Doc[];

    expect(Array.isArray(records)).toBe(true);
    expect(records.map((record) => record.id)).toEqual(['r1', 'r2', 'r3']);
    expect(warnings).toHaveLength(2);
    expect(warnings[0][0]).toMatchObject({
      obj: { table: 'legacy_cell_doc', column: 'tag_list', id: 'r1', error: 'SyntaxError' },
    });
    expect(warnings[1][0]).toMatchObject({
      obj: { table: 'legacy_cell_doc', column: 'settings', id: 'r3', error: 'SyntaxError' },
    });
    expect(JSON.stringify(warnings)).not.toContain(LEGACY_WORD);
  });

  it('a column whose deserialize answers with a rejecting promise is omitted the same way', async () => {
    class LaterColumn implements Column<number, number> {
      constructor(public name: string) {}

      deserialize(storedValue: number | null): Promise<number | null> {
        return storedValue === -1 ? Promise.reject(new RangeError('unreadable')) : Promise.resolve(storedValue);
      }
    }
    interface Later extends Record {
      title: string;
      later: number;
      after: string;
    }
    class LaterTable extends Table<Later> {
      public name = 'legacy_cell_later';
      public columns = withRecordColumns<Later>({
        title: new StringColumn('title'),
        later: new LaterColumn('later'),
        after: new StringColumn('after'),
      });
    }
    const laterTable = new LaterTable() as Table<Later>;
    const serializer = new RecordSerializer<Later>(laterTable);
    const warnings = warningsOf(serializer);
    const rows: SerializedRecord[] = [
      { id: 'l1', title: 'one', later: 1, after: 'x' },
      { id: 'l2', title: 'two', later: -1, after: 'y' },
    ];

    const records = await serializer.deserializeAll(rows);

    expect(records[0]).toMatchObject({ id: 'l1', title: 'one', later: 1, after: 'x' });
    expect(records[1]).toMatchObject({ id: 'l2', title: 'two', after: 'y' });
    expect(records[1]).not.toHaveProperty('later');
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toMatchObject({
      obj: { table: 'legacy_cell_later', column: 'later', id: 'l2', error: 'RangeError' },
    });
  });
});
