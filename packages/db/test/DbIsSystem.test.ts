import { SourceRepository } from '@proteinjs/reflection';
import { Serializer } from '@proteinjs/serializer';
import { QueryBuilder, Statement } from '@proteinjs/db-query';
import {
  Db,
  DbDriver,
  DbDriverDmlStatementConfig,
  DbDriverQueryStatementConfig,
  getDb,
  getDbAsSystem,
} from '../src/Db';
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

/**
 * A builder that was read from a text (a page's query, as the service hands it over) is a DESCRIPTION of a
 * query. The Db does not run it as it came and adds nothing to it: it builds its own builder from the
 * description (`QueryBuilder.rebuiltFrom`), so the column queries it adds land in a builder the Db made, and
 * are in the statement whatever else the description held. A query inside the description is a query of a
 * table of its own: that table's door is asked and that table's column queries are added to it, as to a
 * query of that table made alone. The description of an update or a delete says which rows and nothing
 * else. A builder the running code made is run as before.
 */
interface Kept extends Record {
  title: string;
  keeper: string;
}

interface Note extends Kept {
  shelfMark: string;
}

/** A column query that keeps every read and write to the rows that hold one value: the shape of a scoped table's. */
const keptBy = (field: string, value: string) => ({
  addToQuery: async (qb: QueryBuilder) => {
    qb.condition({ field, operator: '=', value });
  },
});

/** Two columns with a column query each: a table's row rules are every one of them. */
class NoteTable extends Table<Note> {
  public name = 'described_note';
  public auth: Table<Note>['auth'] = { db: { all: 'public' } };
  public columns = withRecordColumns<Note>({
    title: new StringColumn('title'),
    keeper: new StringColumn('keeper', keptBy('keeper', 'the keeper of notes')),
    shelfMark: new StringColumn('shelf_mark', keptBy('shelfMark', 'the shelf of notes')),
  });
}

class ShelfTable extends Table<Kept> {
  public name = 'described_shelf';
  public auth: Table<Kept>['auth'] = { db: { all: 'public' } };
  public columns = withRecordColumns<Kept>({
    title: new StringColumn('title'),
    keeper: new StringColumn('keeper', keptBy('keeper', 'the keeper of shelves')),
  });
}

/** No door of its own: an admin's alone. */
class VaultTable extends Table<Kept> {
  public name = 'described_vault';
  public columns = withRecordColumns<Kept>({
    title: new StringColumn('title'),
    keeper: new StringColumn('keeper'),
  });
}

/** Keeps the text of every statement it is handed. */
class RecordingDriver extends AcceptingDriver {
  statements: string[] = [];

  /** No rows behind it; a count answers none. */
  async runQuery(generateStatement?: (config: DbDriverQueryStatementConfig) => Statement): Promise<never[]> {
    if (!generateStatement) {
      return [];
    }

    const { sql } = generateStatement({
      useParams: true,
      useNamedParams: true,
      prefixTablesWithDb: false,
      getDriverColumnType: () => 'STRING(MAX)',
      handleCaseSensitivity: (_tableName, columnName) => columnName,
    });
    this.statements.push(sql);
    return (sql.indexOf('SELECT COUNT(') === 0 ? [{ count: 0 }] : []) as never[];
  }

  async runDml(generateStatement: (config: DbDriverDmlStatementConfig) => Statement): Promise<number> {
    this.statements.push(
      generateStatement({
        useParams: true,
        useNamedParams: true,
        prefixTablesWithDb: false,
        getDriverColumnType: () => 'STRING(MAX)',
      }).sql
    );
    return 1;
  }
}

describe('the Db builds its own builder from a builder read from a text', () => {
  const notes = new NoteTable() as Table<Note>;
  const shelves = new ShelfTable() as Table<Kept>;
  const vault = new VaultTable() as Table<Kept>;
  const tables: { [name: string]: Table<any> } = { [notes.name]: notes, [shelves.name]: shelves, [vault.name]: vault };
  const recording = new RecordingDriver();
  const tableNamed = (name: string): Table<any> => {
    if (!tables[name]) {
      throw new Error(`Unable to find table: ${name}`);
    }
    return tables[name];
  };
  /** A session's Db over the recording driver; made once the watchers' registry is set (a Db reads it as it is made). */
  let db: Db<Note>;
  /** A builder as a text gives it to the Db: written and read by the serializer, every builder inside it too. */
  const read = (qb: QueryBuilder<Note>): QueryBuilder<Note> => Serializer.deserialize(Serializer.serialize(qb));
  const described = () =>
    read(new QueryBuilder<Note>(notes.name).condition({ field: 'title', operator: 'LIKE', value: 'a%' }));
  const withoutDirections = (qb: QueryBuilder<Note>): QueryBuilder<Note> => {
    const from: any = qb.graph;
    const undirected = new (from.constructor as new (options: object) => any)({ directed: false });
    from.nodes().forEach((id: string) => undirected.setNode(id, from.node(id)));
    from.edges().forEach((edge: { v: string; w: string }) => undirected.setEdge(edge.v, edge.w));
    (qb as any).graph = undirected;
    return qb;
  };
  const held = (change: { [field: string]: unknown }): QueryBuilder<Note> => Object.assign(described(), change);

  let originalWatchers: unknown[] | undefined;

  beforeAll(() => {
    originalWatchers = objectCache()['@proteinjs/db/TableWatcher'];
    objectCache()['@proteinjs/db/TableWatcher'] = [];
    (TableWatcherRunner as unknown as TableWatcherRunnerStatics).tableWatcherMap = undefined;
    db = new Db<Note>(recording, tableNamed, transactions);
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
    recording.statements.length = 0;
  });

  test('the table’s column queries are in the statement of every road, whatever bookkeeping the description held', async () => {
    const descriptions = [
      described,
      () => held({ idCounter: 'x' }),
      () => held({ idCounter: 9007199254740992 }),
      () => held({ currentContextIds: ['__proto__', 'node_0', 5] }),
      () => held({ paginationNodeId: 'node_0' }),
    ];
    // A road that throws is told among the statements, so the list says what each road did.
    const told = (road: Promise<unknown>) =>
      road.catch((error: Error) => recording.statements.push(`threw: ${error.message}`));
    for (const description of descriptions) {
      recording.statements.length = 0;
      await told(db.query(notes, description()));
      await told(db.getRowCount(notes, description()));
      await told(db.update(notes, { title: 'b' }, description()));
      await told(db.delete(notes, description()));
      expect(recording.statements).toEqual([
        'SELECT * FROM `described_note` WHERE `title` LIKE @param0 AND `keeper` = @param1 AND `shelf_mark` = @param2;',
        'SELECT COUNT(*) as count FROM `described_note` WHERE `title` LIKE @param0 AND `keeper` = @param1 AND `shelf_mark` = @param2;',
        'UPDATE `described_note` SET `title` = @param0, `updated` = @param1 WHERE `title` LIKE @param2 AND `keeper` = @param3 AND `shelf_mark` = @param4;',
        'SELECT * FROM `described_note` WHERE `title` LIKE @param0 AND `keeper` = @param1 AND `shelf_mark` = @param2;',
      ]);
    }
  });

  test('a description no builder writes is refused before anything is run', async () => {
    const descriptions = [
      () => held({ rootId: '__proto__' }),
      () => held({ rootId: 'node_0' }),
      () => held({ rootId: { value: 5 } }),
      () => withoutDirections(described()),
      () => held({ graph: { nodes: [], edges: [] } }),
    ];
    for (const description of descriptions) {
      await expect(db.query(notes, description())).rejects.toThrow('no query was built');
      await expect(db.getRowCount(notes, description())).rejects.toThrow('no query was built');
      await expect(db.update(notes, { title: 'b' }, description())).rejects.toThrow('no query was built');
      await expect(db.delete(notes, description())).rejects.toThrow('no query was built');
    }
    expect(recording.statements).toEqual([]);
  });

  test('a query inside the description is a query of its own table: that table’s column queries are added to it, and its door is asked', async () => {
    const within = (table: { name: string }) => new QueryBuilder<Note>(table.name).select({ fields: ['title'] });
    const holding = (inner: QueryBuilder<Note>) =>
      read(new QueryBuilder<Note>(notes.name).condition({ field: 'title', operator: 'IN', value: inner }));

    await db.query(notes, holding(within(shelves)));
    expect(recording.statements).toEqual([
      'SELECT * FROM `described_note` WHERE `title` IN (SELECT `title` FROM `described_shelf` WHERE `keeper` = @sq0_param0) AND `keeper` = @param0 AND `shelf_mark` = @param1;',
    ]);

    recording.statements.length = 0;
    await expect(db.query(notes, holding(within(vault)))).rejects.toThrow(
      'User is not authorized to query table: described_vault'
    );
    await expect(db.query(notes, holding(within({ name: 'described_nowhere' })))).rejects.toThrow(
      'Unable to find table: described_nowhere'
    );
    expect(recording.statements).toEqual([]);

    // A Db that runs as the system asks no door of a query inside, as it asks none of the query itself.
    await new Db<Note>(recording, tableNamed, transactions, true).query(notes, holding(within(vault)));
    expect(recording.statements).toEqual([
      'SELECT * FROM `described_note` WHERE `title` IN (SELECT `title` FROM `described_vault`) AND `keeper` = @param0 AND `shelf_mark` = @param1;',
    ]);
  });

  test('the description of an update or a delete says which rows and nothing else: one that says more is refused, and nothing is read or written', async () => {
    const rows = () => new QueryBuilder<Note>(notes.name).condition({ field: 'id', operator: '=', value: 'a note' });
    const sayingMore = [
      rows().aggregate({ function: 'MAX', field: 'title', resultProp: 'latest' }),
      rows().select({ fields: ['title'] }),
      rows().groupBy(['title']),
      rows().timeBucket({ field: 'created', unit: 'day', resultProp: 'day' }),
      rows().sort([{ field: 'title' }]),
      rows().paginate({ start: 0, end: 1 }),
    ];
    const refusal = 'says which rows and nothing else';
    for (const query of sayingMore) {
      await expect(db.update(notes, { title: 'b' }, read(query))).rejects.toThrow(refusal);
      await expect(db.delete(notes, read(query))).rejects.toThrow(refusal);
    }
    expect(recording.statements).toEqual([]);

    // A read says more: the same description is read, under the table's column queries.
    await db.query(notes, read(sayingMore[0]));
    expect(recording.statements).toEqual([
      'SELECT MAX(`title`) as latest FROM `described_note` WHERE `id` = @param0 AND `keeper` = @param1 AND `shelf_mark` = @param2;',
    ]);
  });

  test('the aggregates read takes a builder the running code made: one read from a text is refused before anything is added to it', async () => {
    const counted = () => new QueryBuilder<Note>(notes.name).aggregate({ function: 'COUNT', resultProp: 'n' });
    const description = read(counted());
    const parts = description.graph.nodes().length;
    await expect(db.queryAggregates(notes, description)).rejects.toThrow('a builder the running code made');
    expect(description.graph.nodes().length).toBe(parts);
    expect(recording.statements).toEqual([]);

    await db.queryAggregates(notes, counted());
    expect(recording.statements).toEqual([
      'SELECT COUNT(*) as n FROM `described_note` WHERE `keeper` = @param0 AND `shelf_mark` = @param1;',
    ]);
  });

  test('a builder the running code made is run as it is: nothing is rebuilt, and a query its code put inside is its own', async () => {
    const theCodes = new QueryBuilder<Note>(vault.name).select({ fields: ['title'] });
    const own = new QueryBuilder<Note>(notes.name).condition({ field: 'title', operator: 'IN', value: theCodes });
    await db.query(notes, own);
    expect(recording.statements).toEqual([
      'SELECT * FROM `described_note` WHERE `title` IN (SELECT `title` FROM `described_vault`) AND `keeper` = @param0 AND `shelf_mark` = @param1;',
    ]);
    // The Db added its column queries to the caller's own builder, as it always has.
    expect(own.graph.nodes().length).toBe(4);
  });
});
