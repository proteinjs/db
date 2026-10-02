import '../generated/index';
import { StatementConfig, StatementFactory } from '../src/StatementFactory';

/**
 * `StatementFactory.insertMany` — the multi-row form of `insert`: one `INSERT … VALUES (…), (…)`
 * over the union of the rows' columns, every value its own parameter, rows bound in the order
 * given, and NULL bound where a row carries no value for a listed column (what the database
 * stores for a column a single-row insert leaves out).
 */
describe('StatementFactory.insertMany', () => {
  interface Doc {
    id: string;
    title: string;
    note?: string | null;
  }

  const tableName = 'Doc';
  const named: StatementConfig = {
    useParams: true,
    useNamedParams: true,
    getDriverColumnType: (_table, column) => (column === 'id' ? 'STRING(36)' : 'STRING(MAX)'),
  };
  const positional: StatementConfig = { useParams: true, useNamedParams: false };

  test('named params: one statement, one tuple per row, every value its own parameter in row order', () => {
    const statement = new StatementFactory<Doc>().insertMany(
      tableName,
      [
        { id: 'd1', title: 'first' },
        { id: 'd2', title: 'second' },
        { id: 'd3', title: 'third' },
      ],
      named
    );

    expect(statement.sql).toBe(
      'INSERT INTO `Doc` (`id`, `title`) VALUES (@param0, @param1), (@param2, @param3), (@param4, @param5);'
    );
    expect(statement.namedParams).toEqual({
      params: { param0: 'd1', param1: 'first', param2: 'd2', param3: 'second', param4: 'd3', param5: 'third' },
      types: {
        param0: 'STRING(36)',
        param1: 'STRING(MAX)',
        param2: 'STRING(36)',
        param3: 'STRING(MAX)',
        param4: 'STRING(36)',
        param5: 'STRING(MAX)',
      },
    });
  });

  test('the column list is the union of the rows, first seen first; a row without a column binds NULL there', () => {
    const statement = new StatementFactory<Doc>().insertMany(
      tableName,
      [
        { id: 'd1', title: 'first' },
        { id: 'd2', title: 'second', note: 'with a note' },
      ],
      named
    );

    expect(statement.sql).toBe(
      'INSERT INTO `Doc` (`id`, `title`, `note`) VALUES (@param0, @param1, @param2), (@param3, @param4, @param5);'
    );
    expect(statement.namedParams?.params).toEqual({
      param0: 'd1',
      param1: 'first',
      param2: null,
      param3: 'd2',
      param4: 'second',
      param5: 'with a note',
    });
    // The NULL still carries the column's declared type: a driver binds a typed null, as a
    // single-row insert of an explicit null does.
    expect(statement.namedParams?.types.param2).toBe('STRING(MAX)');
  });

  test('positional params: the same shape with ? placeholders and the values in row order', () => {
    const statement = new StatementFactory<Doc>().insertMany(
      tableName,
      [
        { id: 'd1', title: 'first' },
        { id: 'd2', title: 'second' },
      ],
      positional
    );

    expect(statement.sql).toBe('INSERT INTO `Doc` (`id`, `title`) VALUES (?, ?), (?, ?);');
    expect(statement.params).toEqual(['d1', 'first', 'd2', 'second']);
  });

  test('one row is the single-row statement, prefixed with the db name when the config asks', () => {
    const statement = new StatementFactory<Doc>().insertMany(tableName, [{ id: 'd1', title: 'only' }], {
      ...named,
      dbName: 'main',
    });

    expect(statement.sql).toBe('INSERT INTO `main`.`Doc` (`id`, `title`) VALUES (@param0, @param1);');
  });

  test('no rows is refused by name — an INSERT with no tuple is not a statement', () => {
    expect(() => new StatementFactory<Doc>().insertMany(tableName, [], named)).toThrow(
      'insertMany requires at least one row (table: Doc)'
    );
  });
});
