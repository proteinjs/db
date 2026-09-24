// TableManager first: it loads the Table/Record/Columns module cycle from its settled entry point.
import { TableManager } from '../src/schema/TableManager';
import { Table } from '../src/Table';
import { StringColumn } from '../src/Columns';

/**
 * The order `TableManager.loadTables` hands absent tables to `SchemaOperations.createTables`:
 * each table after the tables its foreign keys reference (`ColumnOptions.references`), grouped
 * by rank and kept in the given order within a rank. The emulator/database half of the proof
 * (a real batch that fails in the enumerated order and lands in this one) lives in the reusable
 * TableManager tests every driver runs.
 */

type CreateOrderInternals = { orderByReferences(tables: Table<any>[]): Table<any>[] };

const tableManager = () =>
  new TableManager({} as any, {} as any, {} as any, {} as any) as unknown as CreateOrderInternals;

/** A table named `name` with one foreign-key column per entry in `references`. */
const table = (name: string, ...references: string[]): Table<any> => {
  const columns: { [property: string]: StringColumn } = { id: new StringColumn('id') };
  references.forEach((referencedTable, index) => {
    columns[`ref${index}`] = new StringColumn(`ref_${index}`, { references: { table: referencedTable } });
  });
  return { name, columns, indexes: [] } as unknown as Table<any>;
};

const names = (tables: Table<any>[]) => tables.map((each) => each.name);

describe('TableManager — the order absent tables are created in', () => {
  it('creates a referenced table before the table enumerated ahead of it that references it', () => {
    expect(names(tableManager().orderByReferences([table('child', 'parent'), table('parent')]))).toEqual([
      'parent',
      'child',
    ]);
  });

  it('groups by rank and keeps the given order within a rank, so the output is deterministic', () => {
    const ordered = tableManager().orderByReferences([
      table('comment', 'post', 'account'),
      table('post', 'account'),
      table('reaction', 'account'),
      table('account'),
      table('tag'),
    ]);

    // rank 0: account, tag (given order) · rank 1: post, reaction (given order) · rank 2: comment
    expect(names(ordered)).toEqual(['account', 'tag', 'post', 'reaction', 'comment']);
  });

  it('allows a table to reference itself', () => {
    expect(names(tableManager().orderByReferences([table('node', 'node'), table('leaf', 'node')]))).toEqual([
      'node',
      'leaf',
    ]);
  });

  it('ignores a reference to a table outside the set (already created, or not registered)', () => {
    expect(names(tableManager().orderByReferences([table('late', 'existing'), table('early')]))).toEqual([
      'late',
      'early',
    ]);
  });

  it('refuses a reference cycle, naming the cycle and every table it blocks', () => {
    const cyclic = () =>
      tableManager().orderByReferences([
        table('free'),
        table('downstream', 'second'),
        table('first', 'third'),
        table('second', 'first'),
        table('third', 'second'),
      ]);

    expect(cyclic).toThrow('foreign keys form a cycle: second -> first -> third -> second');
    expect(cyclic).toThrow('Tables it blocks: downstream, first, second, third');
  });
});
