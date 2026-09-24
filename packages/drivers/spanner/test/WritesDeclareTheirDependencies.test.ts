import {
  BooleanColumn,
  Db,
  Record,
  StringColumn,
  Table,
  Transaction,
  TransactionRunner,
  getDb,
  getDbAsSystem,
  tableByName,
  withRecordColumns,
} from '@proteinjs/db';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { SourceRepository } from '@proteinjs/reflection';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * A write released by a page that is going away can OVERTAKE the write it depends on at the
 * server: the row's INSERT is still being served (its DML not yet executed, so no lock exists to
 * wait on) when the row's text UPDATE, carried past teardown by keepalive, runs to completion —
 * zero rows matched, no conflict, OK. Silently. The page that could have ordered the two is gone.
 *
 * Contract under test: the write DECLARES the rows it depends on
 * (`TransactionRunner.run(ops, { afterRows })`) and the server, which outlives the page, waits —
 * bounded — for each to exist AND be visible to the caller before running the operations. A row
 * that never appears fails the request with a plain clause: never a silent zero-row write, never
 * a hang. A write with nothing to declare is the request it always was.
 *
 * The dependency is modelled as it happens: its insert is DISPATCHED after the dependent write
 * arrives (the insert landing N ms later). At the pre-change server the second argument is
 * ignored and the update matches nothing — the row, inserted afterwards, carries its original
 * text and the run resolved OK. With the wait, the update lands on the row.
 */

interface Line extends Record {
  text: string;
  /** The row is visible to a caller only once `visible` is true (a scope's grant, modelled). */
  visible?: boolean | null;
}

class DeclaredRowTestTable extends Table<Line> {
  name = 'db_test_declared_rows';
  columns = withRecordColumns<Line>({
    text: new StringColumn('text'),
    visible: new BooleanColumn('visible', {
      // Exists ≠ visible: a caller's read of this table sees only rows whose `visible` is true —
      // the shape of a scoped read whose grant commits after the row (a system read sees all).
      addToQuery: async (qb, runAsSystem) => {
        if (!runAsSystem) {
          qb.condition({ field: 'visible', operator: '=', value: true });
        }
      },
    }),
  });
}

const table: Table<Line> = new DeclaredRowTestTable();
const getTable = (tableName: string) => (tableName === table.name ? table : tableByName(tableName));
const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};
const spannerDriver = new SpannerDriver(spannerConfig, getTable);

/** The request as it arrives at the server: an operations array and, when the write declares
 *  its dependencies, the options — typed loosely so the SAME test file runs against the
 *  pre-change runner (whose `run` took the operations alone and ignored anything after them). */
type Runner = { run: (ops: unknown[], options?: { afterRows?: string[] }) => Promise<void> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An update of `id`'s text, as the client `Transaction` queues it. */
const updateOps = (id: string, text: string) => [{ name: 'update', args: [table, { id, text }] }];

/**
 * Run `work` with `driver` as the process's default db driver — the one the server's runner and
 * `getDb()` resolve — restoring the previous one after. How a case gives the server a driver
 * configured differently from the suite's.
 */
const onDefaultDriver = async <T>(driver: SpannerDriver, work: () => Promise<T>): Promise<T> => {
  const registry = globalThis as unknown as { __proteinjs_db_defaultDbDriver?: unknown };
  const previous = registry.__proteinjs_db_defaultDbDriver;
  registry.__proteinjs_db_defaultDbDriver = driver;
  try {
    return await work();
  } finally {
    registry.__proteinjs_db_defaultDbDriver = previous;
  }
};

describe('a write declares the rows it depends on; the server waits for them', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const db = new Db(spannerDriver, getTable, new TransactionContext());
  let inserts: Promise<unknown>[] = [];

  beforeAll(async () => {
    registerTestUser();
    (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ] = [table];
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    await spannerDriver.createDbIfNotExists();
    await spannerDriver.getTableManager().loadTable(table);
  }, 60000);

  afterAll(async () => {
    await dropTable(table);
    await SpannerEmulatorProvisioner.release();
    delete (SourceRepository.get() as unknown as { objectCache: { [key: string]: unknown[] } }).objectCache[
      '@proteinjs/db/Table'
    ];
    clearTestUser();
  }, 60000);

  afterEach(async () => {
    await Promise.all(inserts);
    inserts = [];
    const leftovers = await getDbAsSystem().query(table, {});
    for (const row of leftovers) {
      await getDbAsSystem().delete(table, { id: row.id } as any);
    }
  }, 30000);

  /** The dependency's insert, dispatched `afterMs` after now — the row landing later. */
  const insertLater = (row: Partial<Line>, afterMs: number) => {
    const insert = sleep(afterMs).then(() => getDbAsSystem().insert(table, row as any));
    inserts.push(insert);
    return insert;
  };

  test('(a) an UPDATE naming a row whose INSERT lands 500 ms later waits for the row and updates it — never a silent zero-row write', async () => {
    const id = 'declared-row-a';
    const insert = insertLater({ id, text: 'typed before the reload', visible: true }, 500);
    const runner = new TransactionRunner() as unknown as Runner;

    const before = Date.now();
    await runner.run(updateOps(id, 'typed before the reload, whole'), { afterRows: [id] });
    const elapsed = Date.now() - before;
    await insert;

    // Pre-change: the run resolved OK at once — the update matched nothing — and the row,
    // inserted afterwards, keeps the text the update should have replaced: the tail of the line,
    // lost silently. With the wait, the update ran after the insert landed.
    expect((await db.get(table, { id })).text).toBe('typed before the reload, whole');
    expect(elapsed).toBeGreaterThanOrEqual(450);
  }, 30000);

  test('the wait is for the row to be VISIBLE to the caller, not merely to exist (a scope whose grant lands after the row)', async () => {
    const id = 'declared-row-visible';
    // The row exists at once — but not to the caller: its grant (modelled by `visible`) lands
    // 400 ms later, in a second write, the way a scope root's owner grant follows its row.
    await getDbAsSystem().insert(table, { id, text: 'root', visible: false } as any);
    const grant = sleep(400).then(() => getDbAsSystem().update(table, { visible: true }, { id }));
    inserts.push(grant);
    const runner = new TransactionRunner() as unknown as Runner;

    const before = Date.now();
    await runner.run(updateOps(id, 'root, edited'), { afterRows: [id] });
    const elapsed = Date.now() - before;
    await grant;

    // Pre-change: the caller-scoped update matched nothing (the row was not visible to the
    // caller yet) and resolved OK; the row keeps its text.
    expect((await db.get(table, { id })).text).toBe('root, edited');
    expect(elapsed).toBeGreaterThanOrEqual(350);
  }, 30000);

  test('(c) a row that never exists: a plain failure at the db driver`s per-operation deadline — never a hang, never a silent OK; the operations did not run', async () => {
    const absent = 'declared-row-never';
    const child = 'declared-row-child-of-never';
    // The bound is the deadline the server's db driver is configured with, read when the write
    // waits — here a driver configured with a short one. A bound of the runner's own would ignore
    // it: the write would wait that bound out instead, and the clause would name it.
    const deadlineMs = 2_000;
    const shortDeadlineDriver = new SpannerDriver({ ...spannerConfig, operationDeadlineMs: deadlineMs }, getTable);
    const runner = new TransactionRunner() as unknown as Runner;
    // One transaction: a new row, and a text update of the row that never lands. Pre-change the
    // insert lands and the update matches nothing — OK; with the wait, nothing runs.
    const ops = [
      { name: 'insert', args: [table, { id: child, text: 'orphan', visible: true }] },
      ...updateOps(absent, 'never'),
    ];

    const before = Date.now();
    await expect(onDefaultDriver(shortDeadlineDriver, () => runner.run(ops, { afterRows: [absent] }))).rejects.toThrow(
      new RegExp(
        `waited ${deadlineMs} ms for rows this write depends on to exist and be visible to the caller; still absent: ${table.name}:${absent} — the write was not run \\(the bound is the db driver's per-operation deadline\\)`
      )
    );
    const elapsed = Date.now() - before;

    expect(elapsed).toBeGreaterThanOrEqual(deadlineMs - 50);
    expect(elapsed).toBeLessThan(deadlineMs + 5_000);
    // The write was not run: no orphan row.
    expect(await getDbAsSystem().get(table, { id: child })).toBeUndefined();
  }, 45_000);

  test('(f) a dependency that lands 12 s after the write arrives — a root birth on a degraded link — is still waited for: the bound sits above it', async () => {
    // Measured on a tethered link (spanner RPC p50 0.4 s, p90 2.4 s): a root's birth took 13 s and
    // every write released behind it met a 10 s bound — refused with the plain clause, and the
    // page that typed them was gone. The bound is the ceiling for a row that NEVER comes; a row
    // that is merely slow must land inside it. The server here runs on the suite's default driver,
    // whose per-operation deadline — the bound — is the driver's default, 60 s.
    const id = 'declared-row-slow-birth';
    const insert = insertLater({ id, text: 'born late', visible: true }, 12_000);
    const runner = new TransactionRunner() as unknown as Runner;

    const before = Date.now();
    await runner.run(updateOps(id, 'born late, edited'), { afterRows: [id] });
    const elapsed = Date.now() - before;
    await insert;

    expect((await db.get(table, { id })).text).toBe('born late, edited');
    expect(elapsed).toBeGreaterThanOrEqual(11_500);
  }, 40000);

  test('a declared id none of the operations reference is refused up front — a malformed request, never a wait', async () => {
    const runner = new TransactionRunner() as unknown as Runner;
    await expect(runner.run(updateOps('declared-row-x', 'x'), { afterRows: ['some-other-row'] })).rejects.toThrow(
      /afterRows names rows none of the operations reference \(some-other-row\) — the write was not run/
    );
  }, 30000);

  test('a declared write inside an ambient transaction is refused, not waited on a snapshot that can never see the row', async () => {
    const runner = new TransactionRunner() as unknown as Runner;
    await expect(
      db.runTransaction(() => runner.run(updateOps('declared-row-y', 'y'), { afterRows: ['declared-row-y'] }))
    ).rejects.toThrow(/afterRows cannot be honoured inside an ambient transaction/);
  }, 30000);

  test('(e) a write with nothing to declare is the request it always was: the operations alone, run at once', async () => {
    const id = 'declared-row-e';
    await getDbAsSystem().insert(table, { id, text: 'plain', visible: true } as any);
    const runSpy = jest.spyOn(TransactionRunner.prototype, 'run');
    try {
      const t = new Transaction();
      t.update(table, { id, text: 'plain, edited' } as any);
      const before = Date.now();
      await t.run();
      expect(Date.now() - before).toBeLessThan(2000);
      // The hand-off carries the operations and nothing else — the same arguments as before.
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runSpy.mock.calls[0]).toHaveLength(1);
      expect((await getDb().get(table, { id })).text).toBe('plain, edited');

      // Declaring a dependency is the one thing that adds to the request.
      const dependent = new Transaction();
      dependent.update(table, { id, text: 'plain, edited twice' } as any);
      await (dependent as unknown as { run: (options?: unknown) => Promise<void> }).run({ afterRows: [id] });
      expect(runSpy.mock.calls[1]).toHaveLength(2);
      expect((runSpy.mock.calls[1] as unknown[])[1]).toEqual({ afterRows: [id] });
      expect((await getDb().get(table, { id })).text).toBe('plain, edited twice');
    } finally {
      runSpy.mockRestore();
    }
  }, 30000);
});
