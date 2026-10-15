import { createHook } from 'async_hooks';
import { SourceRepository } from '@proteinjs/reflection';
import { Db, DbDriver } from '../src/Db';
import { TableWatcherRunner } from '../src/TableWatcherRunner';
import { Table } from '../src/Table';
import { Record, SerializedRecord, withRecordColumns } from '../src/Record';
import { DateTimeColumn, IntegerColumn, ObjectColumn, StringColumn } from '../src/Columns';
import { DefaultTransactionContextFactory, TransactionContextData } from '../src/transaction/TransactionContextFactory';
import type { Moment } from 'moment';

/**
 * A MEASURE, never a gate: hydrating 1,000 rows with ten DateTime columns through `Db.query`, read
 * as wall time, promises created (async_hooks) and microtask rounds — the numbers are printed for
 * the person reading the run and nothing here asserts a threshold (CI's machines vary). The one
 * assertion is that the rows came back.
 */

interface Wide extends Record {
  title: string;
  body: string;
  count: number;
  payload: { tags: string[]; n: number } | null;
  t0: Moment | null;
  t1: Moment | null;
  t2: Moment | null;
  t3: Moment | null;
  t4: Moment | null;
  t5: Moment | null;
  t6: Moment | null;
  t7: Moment | null;
  t8: Moment | null;
  t9: Moment | null;
}

class WideTable extends Table<Wide> {
  public name = 'hydration_wide';
  public columns = withRecordColumns<Wide>({
    title: new StringColumn('title'),
    body: new StringColumn('body', undefined, 'MAX'),
    count: new IntegerColumn('count'),
    payload: new ObjectColumn('payload'),
    t0: new DateTimeColumn('t0'),
    t1: new DateTimeColumn('t1'),
    t2: new DateTimeColumn('t2'),
    t3: new DateTimeColumn('t3'),
    t4: new DateTimeColumn('t4'),
    t5: new DateTimeColumn('t5'),
    t6: new DateTimeColumn('t6'),
    t7: new DateTimeColumn('t7'),
    t8: new DateTimeColumn('t8'),
    t9: new DateTimeColumn('t9'),
  });
}

const wideTable = new WideTable() as Table<Wide>;

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

class RowsDriver implements DbDriver {
  constructor(private readonly rows: SerializedRecord[]) {}

  getDbName(): string {
    return 'test';
  }

  async createDbIfNotExists(): Promise<void> {}

  async createDb(): Promise<void> {}

  async dropDb(): Promise<void> {}

  getTableManager(): never {
    throw new Error('not used by this measure');
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

const storedRows = (count: number): SerializedRecord[] =>
  Array.from({ length: count }, (_, row) => {
    const stored: SerializedRecord = {
      id: `row-${row}`,
      created: new Date(1_600_000_000_000 + row),
      updated: new Date(1_600_000_000_000 + row),
      title: `title ${row}`,
      body: 'x'.repeat(400),
      count: row,
      payload: JSON.stringify({ tags: ['a', 'b', 'c'], n: row }),
    };
    for (let i = 0; i < 10; i++) {
      stored[`t${i}`] = new Date(1_700_000_000_000 + row * 100 + i);
    }
    return stored;
  });

type Measure = { ms: number; promises: number; microtaskRounds: number };

/** Wall time, promises created and microtask rounds while `act` runs. */
const measure = async (act: () => Promise<unknown>): Promise<Measure> => {
  let promises = 0;
  const hook = createHook({
    init(_asyncId, type) {
      if (type === 'PROMISE') {
        promises++;
      }
    },
  });
  let microtaskRounds = 0;
  let running = true;
  const round = () => {
    if (!running) {
      return;
    }
    microtaskRounds++;
    queueMicrotask(round);
  };
  hook.enable();
  const started = process.hrtime.bigint();
  queueMicrotask(round);
  await act();
  running = false;
  const ms = Number(process.hrtime.bigint() - started) / 1_000_000;
  hook.disable();
  return { ms: Math.round(ms * 10) / 10, promises, microtaskRounds };
};

describe('hydration measure', () => {
  it('reports 1,000 rows with ten DateTime columns through Db.query (wall ms, promises, microtask rounds)', async () => {
    const rows = storedRows(1000);
    const db = new Db(new RowsDriver(rows), () => wideTable, new TestTransactionContextFactory(), true);
    // one warm-up pass, then the measured passes
    await db.query(wideTable, {});

    const passes: Measure[] = [];
    let records: Wide[] = [];
    for (let i = 0; i < 5; i++) {
      passes.push(await measure(async () => (records = await db.query(wideTable, {}))));
    }
    const readAll = await measure(async () => {
      for (const record of records) {
        record.t0!.valueOf();
        record.created.valueOf();
      }
    });

    process.stdout.write(
      `hydration measure — 1,000 rows × (10 DateTime + created/updated + 4 plain columns), Db.query, 5 passes:\n` +
        passes
          .map(
            (pass, i) =>
              `  pass ${i + 1}: ${pass.ms} ms · ${pass.promises} promises · ${pass.microtaskRounds} microtask rounds`
          )
          .join('\n') +
        `\n  then reading t0 + created on every record: ${readAll.ms} ms · ${readAll.promises} promises\n`
    );
    expect(records).toHaveLength(1000);
  });
});
