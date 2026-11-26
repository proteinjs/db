import { SourceRepository } from '@proteinjs/reflection';
import { Condition, QueryBuilder, Statement } from '@proteinjs/db-query';
import { Db, DbDriver, DbDriverDmlStatementConfig } from '../src/Db';
import { Table } from '../src/Table';
import { Record, RecordSerializer, withRecordColumns } from '../src/Record';
import { BooleanColumn, ObjectColumn, ReferenceArrayColumn, StringColumn } from '../src/Columns';
import { ReferenceArray } from '../src/reference/ReferenceArray';
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

/**
 * `Db.update`'s contract for a column's own step before the write (`ColumnOptions.onBeforeUpdate`, the
 * update-side twin of the before-insert hook pinned above), against the same recording driver: the step runs
 * once an update, after the columns' update values and the before-update table watcher, with the payload as it
 * is written and the caller's authority, on every update of the table; it is told which rows the update writes
 * (the id of its one row when it names its row by id, and its own conditions, which a step may add to); a step
 * that throws refuses the update and its own statement is not issued; the two roads that end in `update` reach
 * it; and a write that matched nothing hands the column's own step the payload. Joined here: this file already
 * holds the recording driver and the transaction context these cases stand on.
 */

interface Page extends Record {
  title?: string;
  stamp?: string;
  locked?: string;
  body?: { text?: string; style?: string };
  parts?: ReferenceArray<Page>;
}

type StepEvent = {
  phase: 'watcher.before' | 'column.step' | 'column.matched-nothing' | 'watcher.after';
  /** The column whose step it is. */
  column?: 'title' | 'stamp';
  payload: Partial<Page>;
  asSystem?: boolean;
  /** The id of the one row the update names, as the step was told it: null when it was told none. */
  rowId?: string | null;
  /** The update's own conditions as the step found them: each as [field, operator, value], by field. */
  where?: [string, string, unknown][];
};
const steps: StepEvent[] = [];
/** The payloads the title column's step refuses: set by a case, cleared before each. */
let refused: (payload: Partial<Page>) => boolean = () => false;
/** A condition the title column's step adds to the update's own conditions: set by a case, cleared before each. */
let narrowedBy: Condition<Page> | undefined;
/** The conditions a builder holds, each as [field, operator, value], by field. */
const whereOf = (qb: QueryBuilder<any>): [string, string, unknown][] =>
  (qb.graph.nodes() as string[])
    .map((nodeId) => qb.graph.node(nodeId))
    .filter((node) => node?.type === 'CONDITION')
    .map((node): [string, string, unknown] => [node.field, node.operator, node.value])
    .sort(([a], [b]) => a.localeCompare(b));

class PageTable extends Table<Page> {
  public name = 'update_step_page';
  /** Every door open to everyone: a session Db reaches the write with no user to resolve. */
  public auth: Table<Page>['auth'] = { db: { all: 'public' } };
  public columns = withRecordColumns<Page>({
    title: new StringColumn('title', {
      onBeforeUpdate: async (table, updateObj, runAsSystem, rows) => {
        steps.push({
          phase: 'column.step',
          column: 'title',
          payload: { ...updateObj },
          asSystem: runAsSystem,
          rowId: rows.id ?? null,
          where: whereOf(rows.conditions),
        });
        if (narrowedBy) {
          rows.conditions.condition(narrowedBy);
        }
        if (refused(updateObj)) {
          throw new Error(`the title column refuses this update of ${table.name}`);
        }
      },
      // The step of a write that matched nothing: this suite's driver answers every update with no row.
      onZeroRowFilteredWrite: async (_table, id, operation, runAsSystem, record) => {
        steps.push({
          phase: 'column.matched-nothing',
          column: 'title',
          payload: { ...record },
          asSystem: runAsSystem,
          rowId: `${operation}:${id}`,
        });
      },
    }),
    stamp: new StringColumn('stamp', {
      updateValue: async () => 'stamped',
      // A second column with a step of its own: every declaring column's step runs, in the table's column order.
      // Declared with three arguments: a step that does not ask about the rows.
      onBeforeUpdate: async (_table, updateObj, runAsSystem) => {
        steps.push({ phase: 'column.step', column: 'stamp', payload: { ...updateObj }, asSystem: runAsSystem });
      },
    }),
    locked: new StringColumn('locked', {
      immutable: true,
      // The table's own rule for a person's write: it is among the conditions a step finds.
      addToQuery: async (qb, runAsSystem, operation) => {
        if (!runAsSystem && operation === 'write') {
          qb.condition({ field: 'locked', operator: 'IS NULL' });
        }
      },
    }),
    body: new ObjectColumn<Page['body']>('body'),
    parts: new ReferenceArrayColumn<Page>('parts', 'update_step_page', false),
  });
}

const pageTable = new PageTable() as Table<Page>;

class PageWatcher implements TableWatcher<Page> {
  name(): string {
    return 'PageWatcher';
  }

  table(): Table<Page> {
    return pageTable;
  }

  async beforeUpdate<T extends Page>(record: Partial<T>): Promise<Partial<T>> {
    steps.push({ phase: 'watcher.before', payload: { ...record } });
    return { ...record, stamp: `${record.stamp}+watched` };
  }

  async afterUpdate<T extends Page>(_recordUpdateCount: number, record: Partial<T>): Promise<void> {
    steps.push({ phase: 'watcher.after', payload: { ...record } });
  }
}

/** A recording driver whose reads answer the rows a case seats, as the table's own serializer stores them. */
class AnsweringDriver extends RecordingDriver {
  rows: unknown[] = [];

  async runQuery(): Promise<never[]> {
    return this.rows as never[];
  }
}

/** A Db over `driver` for a person (`asSystem` false) or the system, its watcher map rebuilt from the page watcher alone. */
const pageDbOver = (driver: DbDriver, asSystem: boolean): Db<Page> => {
  (TableWatcherRunner as unknown as TableWatcherRunnerStatics).tableWatcherMap = undefined;
  return new Db<Page>(driver, () => pageTable, new TestTransactionContextFactory(), asSystem);
};

/** The title column's steps: the column whose step a case makes refuse. */
const columnSteps = () => steps.filter((step) => step.phase === 'column.step' && step.column === 'title');

describe("Db.update: a column's own step before the write", () => {
  let originalWatchers: unknown[] | undefined;

  beforeAll(() => {
    originalWatchers = objectCache()['@proteinjs/db/TableWatcher'];
    objectCache()['@proteinjs/db/TableWatcher'] = [new PageWatcher()];
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
    steps.length = 0;
    refused = () => false;
    narrowedBy = undefined;
  });

  test("an update runs each declaring column's step once, in column order, after the update values and the before-update watcher, with the payload as it is written, the caller's authority and the rows it writes, and then issues its statement", async () => {
    const driver = new RecordingDriver();

    await pageDbOver(driver, false).update(pageTable, { id: 'p1', title: 'new', locked: 'never written' });

    // Both declaring columns' steps, in the table's column order, between the watcher's two hooks. The write
    // matched no row (this suite's driver answers none), so the title column's step for that ran after it.
    expect(steps.map((step) => [step.phase, step.column])).toEqual([
      ['watcher.before', undefined],
      ['column.step', 'title'],
      ['column.step', 'stamp'],
      ['column.matched-nothing', 'title'],
      ['watcher.after', undefined],
    ]);
    const [step] = columnSteps();
    // As written: the value the stamp column set as the watcher left it, and nothing of the column no update writes.
    expect(step.payload).toMatchObject({ id: 'p1', title: 'new', stamp: 'stamped+watched' });
    expect(step.payload).not.toHaveProperty('locked');
    expect(step.asSystem).toBe(false);
    expect(driver.dml).toHaveLength(1);
    expect(driver.dml[0].sql).toMatch(/^UPDATE /);
    expect(driver.dml[0].sql).toContain('update_step_page');
    const bound = Object.values(driver.dml[0].params);
    expect(bound).toEqual(expect.arrayContaining(['new', 'stamped+watched']));
    expect(bound).not.toContain('never written');
    // The rows it writes, as the step is told them: the id of its one row, and its own conditions (the id and the
    // table's own rule for a person's write).
    expect([step.rowId, step.where]).toEqual([
      'p1',
      [
        ['id', '=', 'p1'],
        ['locked', 'IS NULL', null],
      ],
    ]);
    // The write that matched nothing hands the column's step for that the payload as it was to be written.
    const [matchedNothing] = steps.filter((each) => each.phase === 'column.matched-nothing');
    expect([matchedNothing.rowId, matchedNothing.asSystem]).toEqual(['write:p1', false]);
    expect(matchedNothing.payload).toMatchObject({ id: 'p1', title: 'new', stamp: 'stamped+watched' });
    expect(matchedNothing.payload).not.toHaveProperty('locked');

    // The system's update is told so; an update of the rows a query selects is one update and one step.
    steps.length = 0;
    await pageDbOver(new RecordingDriver(), true).update(pageTable, { title: 'every' }, { stamp: 'old' });
    expect(columnSteps().map((each) => [each.payload.title, each.asSystem, each.rowId, each.where])).toEqual([
      ['every', true, null, [['stamp', '=', 'old']]],
    ]);

    // An update names its one row by the record's id, or by a query written as an object that holds an id. Rows
    // named by a builder are named by conditions, whatever id the record holds beside it.
    const toldOf = async (update: (db: Db<Page>) => Promise<number>) => {
      steps.length = 0;
      await update(pageDbOver(new RecordingDriver(), false));
      return columnSteps().map((each) => each.rowId);
    };
    expect(await toldOf((db) => db.update(pageTable, { title: 'by a query that holds an id' }, { id: 'p2' }))).toEqual([
      'p2',
    ]);
    expect(
      await toldOf((db) => db.update(pageTable, { title: 'by a query that holds none' }, { title: 'old' }))
    ).toEqual([null]);
    expect(
      await toldOf((db) =>
        db.update(
          pageTable,
          { id: 'p1', title: 'by a builder' },
          new QueryBuilder<Page>(pageTable.name).condition({ field: 'id', operator: 'IN', value: ['p1'] })
        )
      )
    ).toEqual([null]);
    // An id is the row's when it is one of the query's own conditions: an object that only inherits one names
    // its rows by the conditions it does hold.
    const inheritsAnId = Object.assign(Object.create({ id: 'p3' }), { title: 'old' });
    expect(
      await toldOf((db) => db.update(pageTable, { title: 'by a query that inherits an id' }, inheritsAnId))
    ).toEqual([null]);
    // No query is no query, however it is said: the record's id names the row.
    expect(
      await toldOf((db) =>
        db.update(pageTable, { id: 'p4', title: 'with a query that is null' }, null as unknown as undefined)
      )
    ).toEqual(['p4']);

    // The conditions a step is handed are the update's own: what a step adds is in that update's statement.
    steps.length = 0;
    narrowedBy = { field: 'stamp', operator: '=', value: 'only this stamp' };
    const narrowed = new RecordingDriver();
    await pageDbOver(narrowed, false).update(pageTable, { id: 'p1', title: 'narrowed' });
    expect(narrowed.dml).toHaveLength(1);
    expect(narrowed.dml[0].sql).toMatch(/WHERE .*`stamp` = /);
    expect(Object.values(narrowed.dml[0].params)).toEqual(expect.arrayContaining(['narrowed', 'only this stamp']));
  });

  test("a step that throws refuses the update: the caller gets the step's own error, the update's own statement is not issued and nothing after the write runs", async () => {
    const driver = new RecordingDriver();
    refused = (payload) => payload.title === 'not this one';

    await expect(pageDbOver(driver, false).update(pageTable, { id: 'p1', title: 'not this one' })).rejects.toThrow(
      'the title column refuses this update of update_step_page'
    );

    expect(driver.dml).toHaveLength(0);
    // The first step's refusal ends the update there: no later column's step, no statement, nothing after.
    expect(steps.map((step) => [step.phase, step.column])).toEqual([
      ['watcher.before', undefined],
      ['column.step', 'title'],
    ]);
    // The system's update is refused the same way: the step is handed the authority and decides for itself.
    await expect(pageDbOver(driver, true).update(pageTable, { id: 'p1', title: 'not this one' })).rejects.toThrow(
      'the title column refuses this update of update_step_page'
    );
    expect(driver.dml).toHaveLength(0);
    // An update the step lets through is written.
    await pageDbOver(driver, false).update(pageTable, { id: 'p1', title: 'this one' });
    expect(driver.dml).toHaveLength(1);
  });

  test('a change of membership and a preserving update end in an update: each runs the step with what it writes, and a refusal there writes nothing', async () => {
    const driver = new AnsweringDriver();
    driver.rows = [
      await new RecordSerializer(pageTable).serialize({
        id: 'p1',
        body: { text: 'kept', style: 'old' },
        parts: new ReferenceArray<Page>('update_step_page', ['a']),
      }),
    ];
    const db = pageDbOver(driver, false);
    const addPart = (id: string) =>
      db.updateArrayMembership(pageTable, {
        recordId: 'p1',
        columnPropertyName: 'parts',
        ops: [{ op: 'add', id, afterId: 'a' }],
      });
    const typeOver = () =>
      db.updatePreserving(pageTable, { id: 'p1', body: { text: 'typed over', style: 'new' } }, [
        { columnPropertyName: 'body', paths: ['text'] },
      ]);

    await addPart('b');
    // The payload carries no title and the title column's step still runs: a step reads the payload it is handed.
    expect(columnSteps().map((step) => [step.payload.title, step.payload.parts?._ids])).toEqual([
      [undefined, ['a', 'b']],
    ]);

    steps.length = 0;
    await typeOver();
    expect(columnSteps().map((step) => step.payload.body)).toEqual([{ text: 'kept', style: 'new' }]);
    expect(driver.dml).toHaveLength(2);

    refused = () => true;
    await expect(addPart('c')).rejects.toThrow('the title column refuses this update of update_step_page');
    await expect(typeOver()).rejects.toThrow('the title column refuses this update of update_step_page');
    expect(driver.dml).toHaveLength(2);

    // A preserving update whose own read finds no row has made no payload: the step of a write that matched
    // nothing is told the row and handed none.
    steps.length = 0;
    refused = () => false;
    driver.rows = [];
    expect(await typeOver()).toBe(0);
    expect(
      steps.filter((each) => each.phase === 'column.matched-nothing').map((each) => [each.rowId, each.payload])
    ).toEqual([['write:p1', {}]]);
    expect(driver.dml).toHaveLength(2);
  });
});
