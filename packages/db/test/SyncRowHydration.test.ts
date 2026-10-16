import { randomBytes } from 'crypto';
import { SourceRepository } from '@proteinjs/reflection';
import { Db, DbDriver } from '../src/Db';
import { TableWatcherRunner } from '../src/TableWatcherRunner';
import { Column, Table } from '../src/Table';
import { Record, RecordSerializer, SerializedRecord, withRecordColumns } from '../src/Record';
import { StringColumn } from '../src/Columns';
import { DefaultTransactionContextFactory, TransactionContextData } from '../src/transaction/TransactionContextFactory';
import { DataKeyMaterial, DataKeyStore } from '../src/encryption/DataKeyStore';
import { EncryptionEnvelope } from '../src/encryption/EncryptionEnvelope';

/**
 * How a result set becomes records: in ONE synchronous pass when no row needs an await — no promise
 * per row, no yield of the event loop between rows (the per-row async chain was the loop's holder
 * under a large read: one awaited generator per row, per hook and per column) — while a row that
 * does need an await (a ciphertext envelope whose key is read asynchronously, a column whose
 * `deserialize` answers with a promise) still settles, through one promise for the set.
 */

interface Doc extends Record {
  title: string;
  first: number;
  second: number;
}

/** Where the loop stood when each cell was read: the row, and whether the sentinel had fired by then. */
const cellsRead: { column: string; row: number; sentinelFired: boolean }[] = [];
let sentinelFired = false;

/**
 * A column that notes, at each read, whether a microtask armed by the FIRST cell read has fired yet:
 * a hydration that yields the loop between rows lets it fire mid-way; a synchronous one never does.
 */
class ObservingColumn implements Column<number, number> {
  constructor(public name: string) {}

  deserialize(storedValue: number | null): number | null {
    if (cellsRead.length === 0) {
      queueMicrotask(() => {
        sentinelFired = true;
      });
    }

    cellsRead.push({ column: this.name, row: storedValue as number, sentinelFired });
    return storedValue;
  }
}

class DocTable extends Table<Doc> {
  public name = 'hydration_doc';
  public columns = withRecordColumns<Doc>({
    title: new StringColumn('title'),
    first: new ObservingColumn('first'),
    second: new ObservingColumn('second'),
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

/** A driver that answers every query with the rows it was handed. */
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

const dbOver = (rows: SerializedRecord[]) =>
  new Db(new RowsDriver(rows), () => docTable, new TestTransactionContextFactory(), true);

const storedRows = (count: number): SerializedRecord[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `row-${i}`,
    created: new Date(1_700_000_000_000 + i),
    updated: new Date(1_700_000_000_000 + i),
    title: `title ${i}`,
    first: i,
    second: i,
  }));

type SourceRepositoryInternals = { objectCache: { [qualifiedName: string]: unknown[] } };
type TableWatcherRunnerStatics = { tableWatcherMap?: unknown };
const objectCache = () => (SourceRepository.get() as unknown as SourceRepositoryInternals).objectCache;
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

const keyFor = (owner: string, version: number): DataKeyMaterial => ({
  owner,
  version,
  cipherKey: randomBytes(32),
  indexKey: randomBytes(32),
});

describe('a result set hydrates in one synchronous pass when no row needs an await', () => {
  beforeEach(() => {
    cellsRead.length = 0;
    sentinelFired = false;
  });

  it('a query over plain rows never yields the event loop between rows', async () => {
    const rows = storedRows(200);

    const records = await dbOver(rows).query(docTable, {});

    expect(records).toHaveLength(200);
    expect(records[199]).toMatchObject({ id: 'row-199', title: 'title 199', first: 199, second: 199 });
    // Every cell of every row was read before the microtask armed by the first cell could fire.
    expect(cellsRead).toHaveLength(400);
    expect(cellsRead.filter((cell) => cell.sentinelFired).map((cell) => `${cell.column}:${cell.row}`)).toEqual([]);
    expect(sentinelFired).toBe(true);
  });

  it('the serializer answers a plain result set with the array itself, not a promise', () => {
    const rows = storedRows(3);

    const records = new RecordSerializer<Doc>(docTable).deserializeAll(rows);

    expect(Array.isArray(records)).toBe(true);
    expect((records as Doc[]).map((record) => record.title)).toEqual(['title 0', 'title 1', 'title 2']);
  });

  it('a column whose deserialize answers with a promise still settles, in column order', async () => {
    class LaterColumn implements Column<number, number> {
      constructor(public name: string) {}

      deserialize(storedValue: number | null): Promise<number | null> {
        return Promise.resolve(storedValue === null ? null : storedValue * 2);
      }
    }
    interface Later extends Record {
      title: string;
      later: number;
      after: string;
    }
    class LaterTable extends Table<Later> {
      public name = 'hydration_later';
      public columns = withRecordColumns<Later>({
        title: new StringColumn('title'),
        later: new LaterColumn('later'),
        after: new StringColumn('after'),
      });
    }
    const laterTable = new LaterTable() as Table<Later>;
    const rows: SerializedRecord[] = [
      { id: 'a', created: new Date(), updated: new Date(), title: 'one', later: 21, after: 'x' },
      { id: 'b', created: new Date(), updated: new Date(), title: 'two', later: null, after: 'y' },
    ];

    const settling = new RecordSerializer<Later>(laterTable).deserializeAll(rows);

    expect(Array.isArray(settling)).toBe(false);
    const records = await settling;
    expect(records.map((record) => record.later)).toEqual([42, null]);
    expect(Object.keys(records[0])).toEqual(['id', 'created', 'updated', 'title', 'later', 'after']);
  });

  it('a row holding a ciphertext envelope takes the async road and decrypts; its plain neighbors ride along', async () => {
    const key = keyFor('owner-1', 4);
    const envelope = new EncryptionEnvelope();
    const keyRead = jest.spyOn(DataKeyStore.prototype, 'getKeyByVersion').mockResolvedValue(key);
    try {
      const rows = storedRows(3);
      rows[1].title = envelope.encrypt('the plaintext', key);

      const settling = new RecordSerializer<Doc>(docTable).deserializeAll(rows);

      expect(Array.isArray(settling)).toBe(false);
      const records = await settling;
      expect(records.map((record) => record.title)).toEqual(['title 0', 'the plaintext', 'title 2']);
      expect(keyRead).toHaveBeenCalledTimes(1);
      expect(keyRead).toHaveBeenCalledWith('owner-1', 4);
      // The plain rows were hydrated in the one pass; the envelope row landed when its key read settled.
      expect(cellsRead.map((cell) => cell.row)).toEqual([0, 0, 2, 2, 1, 1]);
    } finally {
      keyRead.mockRestore();
    }
  });

  it('a stored column the table no longer declares is omitted; a column without deserialize passes its value through', async () => {
    const rows: SerializedRecord[] = [
      { id: 'a', created: new Date(), updated: new Date(), title: 'one', first: 1, second: 1, retired: 'gone' },
    ];

    const [record] = (await new RecordSerializer<Doc>(docTable).deserializeAll(rows)) as Doc[];

    expect(record).toMatchObject({ id: 'a', title: 'one', first: 1, second: 1 });
    expect('retired' in record).toBe(false);
  });
});
