import moment, { Moment } from 'moment';
import { QueryBuilder } from '@proteinjs/db-query';
import {
  DbDriver,
  Db,
  Record,
  Table,
  DefaultTransactionContextFactory,
  RecordIterator,
  QueryBuilderFactory,
} from '@proteinjs/db';
import { DbTestEnvironment } from '../util/DbTestEnvironment';
import { recordIteratorTestTables, IterationRow } from '../util/tables/recordIteratorTestTables';

/**
 * RecordIterator's iteration contract under CONCURRENT WRITES — the offset-window drift class.
 *
 * Offset paging frames every window by position (`OFFSET n`), so a row deleted behind the
 * iterator slides an unvisited row into the already-consumed range (SKIP), and a row inserted
 * ahead of the consumed prefix slides a consumed row back into the next window (DUPLICATE).
 * Cursor windows frame by the tail row's sort values instead, so concurrent writes can never
 * shift the frame. These tests mutate the table exactly at a window boundary (window size 3,
 * mutation after the 3rd yield) and assert the OUTCOME: every seeded row visited exactly once.
 */
export const recordIteratorTests = (
  driver: DbDriver,
  transactionContextFactory: DefaultTransactionContextFactory,
  dropTable: (table: Table<any>) => Promise<void>
) => {
  return () => {
    const db = new Db(driver, undefined, transactionContextFactory);
    const testEnv = new DbTestEnvironment(driver, dropTable);
    const table = recordIteratorTestTables.IterationRow;
    const WINDOW = 3;

    beforeAll(async () => await testEnv.beforeAll(), 30000);
    afterAll(async () => await testEnv.afterAll(), 30000);

    beforeEach(async () => {
      await db.delete(
        table,
        new QueryBuilderFactory().getQueryBuilder(table).condition({ field: 'id', operator: 'IS NOT NULL' })
      );
    });

    /** Seed rows r01..rNN with seq 10, 20, 30, ... (gaps leave room to insert ahead of them). */
    const seed = async (count: number): Promise<IterationRow[]> => {
      const rows: IterationRow[] = [];
      for (let i = 1; i <= count; i++) {
        rows.push(
          await db.insert(table, { name: `r${String(i).padStart(2, '0')}`, seq: i * 10 } as Omit<
            IterationRow,
            keyof Record
          >)
        );
      }
      return rows;
    };

    const seqAscQuery = () =>
      new QueryBuilderFactory()
        .getQueryBuilder(table)
        .sort([{ field: 'seq', desc: false }]) as QueryBuilder<IterationRow>;

    /** Iterate, running `atWindowBoundary` right after the first window's last row is consumed. */
    const iterateWithBoundaryMutation = async (
      query: QueryBuilder<IterationRow> | Partial<IterationRow>,
      atWindowBoundary: () => Promise<void>
    ): Promise<string[]> => {
      const iterator = new RecordIterator<IterationRow>(table, query, WINDOW, db);
      const visited: string[] = [];
      let mutated = false;
      for await (const row of iterator) {
        visited.push(row.name);
        if (!mutated && visited.length === WINDOW) {
          mutated = true;
          await atWindowBoundary();
        }
      }
      return visited;
    };

    test('a row deleted behind the iterator never causes surviving rows to be skipped', async () => {
      await seed(9);
      const visited = await iterateWithBoundaryMutation(seqAscQuery(), async () => {
        // Delete an ALREADY-CONSUMED row: under offset paging the whole set slides one position
        // left, so the next `OFFSET 3` window starts one row too far — r04 is skipped.
        const deleted = await db.delete(table, { name: 'r01' });
        expect(deleted).toBe(1);
      });
      expect(visited).toEqual(['r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07', 'r08', 'r09']);
    });

    test('a row inserted ahead of the consumed prefix never duplicates rows', async () => {
      await seed(9);
      const visited = await iterateWithBoundaryMutation(seqAscQuery(), async () => {
        // Insert a row that sorts BEFORE every consumed row: under offset paging the set slides
        // one position right, so the next `OFFSET 3` window re-serves the last consumed row.
        await db.insert(table, { name: 'x-front', seq: 1 } as Omit<IterationRow, keyof Record>);
      });
      // Every seeded row exactly once; whether the concurrent insert surfaces is not part of the
      // contract (a cursor window anchored past it correctly excludes it), but duplicates are.
      const seeded = visited.filter((name) => name !== 'x-front');
      expect(seeded).toEqual(['r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07', 'r08', 'r09']);
    });

    test('default iteration (no sort) is complete under a concurrent delete', async () => {
      const rows = await seed(7);
      // With no consumer sort the iterator orders by id — learn the iteration order first.
      const idOrder = rows
        .map((row) => ({ id: row.id, name: row.name }))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((row) => row.name);
      const visited = await iterateWithBoundaryMutation({}, async () => {
        // Delete the first row in iteration order (already consumed).
        const deleted = await db.delete(table, { name: idOrder[0] });
        expect(deleted).toBe(1);
      });
      expect(visited).toEqual(idOrder);
    });

    test('tied sort values across a window boundary are all visited exactly once', async () => {
      // Six rows over two stampedAt values, window size 3: the boundary falls INSIDE the t1 tie
      // (t1 fills the first window's tail and continues into the second). A position-framed or
      // single-axis cursor breaks here; the id tiebreak walks through the tie.
      const t1 = moment('2026-08-10T12:00:00.000Z');
      const t2 = moment('2026-08-09T12:00:00.000Z');
      const stamps = [t1, t1, t1, t1, t2, t2];
      for (let i = 0; i < stamps.length; i++) {
        await db.insert(table, {
          name: `s${String(i + 1).padStart(2, '0')}`,
          stampedAt: stamps[i],
        } as Omit<IterationRow, keyof Record>);
      }
      const query = new QueryBuilderFactory()
        .getQueryBuilder(table)
        .sort([{ field: 'stampedAt', desc: true }]) as QueryBuilder<IterationRow>;
      const iterator = new RecordIterator<IterationRow>(table, query, WINDOW, db);
      const visited: { name: string; stampedAt?: Moment | null }[] = [];
      for await (const row of iterator) {
        visited.push({ name: row.name, stampedAt: row.stampedAt });
      }
      expect(visited.map((v) => v.name).sort()).toEqual(['s01', 's02', 's03', 's04', 's05', 's06']);
      // Order honors the sort: all t1 rows before all t2 rows.
      const t1Names = visited.slice(0, 4).map((v) => moment(v.stampedAt!).toISOString());
      expect(t1Names).toEqual(Array(4).fill(t1.toISOString()));
    });

    test('iteration never mutates the caller query builder', async () => {
      await seed(4);
      const qb = seqAscQuery();
      const nodesBefore = qb.graph.nodes().length;
      const iterator = new RecordIterator<IterationRow>(table, qb, WINDOW, db);
      const visited: string[] = [];
      for await (const row of iterator) {
        visited.push(row.name);
      }
      expect(visited).toHaveLength(4);
      // The old implementation paginated the CALLER's builder (and re-ran column-query
      // injection into it every page); iteration must build windows on fresh copies instead.
      expect(qb.graph.nodes().length).toBe(nodesBefore);
      expect(qb.paginationNodeId).toBeUndefined();
    });
  };
};
