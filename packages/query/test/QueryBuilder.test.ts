import { QueryBuilder } from '../src/QueryBuilder';

describe('QueryBuilder - Factory tests', () => {
  interface Employee {
    id: number;
    name: string;
    age: number;
    country: string;
  }

  const dbName = 'test';
  const tableName = 'Employee';

  test('fromObject API', () => {
    const queryObject = {
      name: 'John Doe',
      country: 'USA',
    };

    const qb = QueryBuilder.fromObject<Employee>(queryObject, tableName);

    // Standard SQL output
    let result = qb.toSql({ dbName });
    const expectedSQL = "SELECT * FROM `test`.`Employee` WHERE `name` = 'John Doe' AND `country` = 'USA';";
    expect(result.sql).toBe(expectedSQL);

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `name` = ? AND `country` = ?;');
    expect(result.params).toEqual(['John Doe', 'USA']);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `name` = @param0 AND `country` = @param1;');
    expect(result.namedParams?.params).toEqual({ param0: 'John Doe', param1: 'USA' });
    expect(result.namedParams?.types).toEqual({ param0: 'string', param1: 'string' });
  });

  test('fromObject API with undefined value', () => {
    const queryObject = {
      name: 'John Doe',
      country: 'USA',
      city: undefined,
    };

    expect(() => {
      QueryBuilder.fromObject<Employee>(queryObject, tableName);
    }).toThrow();
  });
});

/**
 * The writer holds one line for every builder, whoever built it: a word it sets into a statement as text is
 * one the language declares (the `Operator`, `LogicalOperator`, `AggregateFunction` and time-bucket unit
 * lists), a result name is a plain name, a page is two whole numbers in their order, a name it quotes holds
 * no quote and no backslash, and a list it walks is a list. Anything else is refused before a statement
 * exists. Values are bound, never written, as before. A builder's own methods only put the first kind of
 * thing into a builder; these cases put the other kind into a part directly.
 */
describe('a statement is written in the query language’s own words', () => {
  interface Employee {
    id: number;
    name: string;
    age: number;
    hired: Date;
  }

  const tableName = 'Employee';
  const config = {
    useParams: true,
    useNamedParams: true,
    dateTruncExpression: (col: string, unit: string) => `TIMESTAMP_TRUNC(${col}, ${unit}, 'UTC')`,
  };

  /** Rewrites a builder's first part of a type. */
  const changed = (qb: QueryBuilder<Employee>, type: string, change: { [field: string]: unknown }) => {
    const id = qb.graph.nodes().find((nodeId: string) => (qb.graph.node(nodeId) as any)?.type === type) as string;
    qb.graph.setNode(id, { ...(qb.graph.node(id) as any), ...change });
    return qb;
  };
  const employees = () => new QueryBuilder<Employee>(tableName);
  const named = () => employees().condition({ field: 'name', operator: '=', value: 'Ada' });
  const counted = () => employees().aggregate({ function: 'COUNT', field: 'age', resultProp: 'total' });
  const bucketed = () => employees().timeBucket({ field: 'hired', unit: 'day', resultProp: 'day' });
  const paged = () => employees().paginate({ start: 0, end: 10 });
  const sorted = () => employees().sort([{ field: 'name', byValues: ['Ada'] as any }]);
  /** Answers to `map`, as a list does, and is not one. */
  const notAList = { length: 1, 0: 'name', map: Array.prototype.map };

  it.each<[string, () => QueryBuilder<Employee>]>([
    ['an operator that is no word of the language', () => changed(named(), 'CONDITION', { operator: 'RESEMBLES' })],
    [
      'an operator that is a word of the language in other letters',
      () => changed(named(), 'CONDITION', { operator: 'like' }),
    ],
    [
      'a logical operator that is no word of the language',
      () =>
        changed(
          employees().or([
            { field: 'name', operator: '=', value: 'Ada' },
            { field: 'age', operator: '>', value: 30 },
          ]),
          'LOGICAL',
          { operator: 'XOR' }
        ),
    ],
    [
      'an aggregate function that is no word of the language',
      () => changed(counted(), 'AGGREGATE', { function: 'MEDIAN' }),
    ],
    [
      'an aggregate’s result name that is not a plain name',
      () => changed(counted(), 'AGGREGATE', { resultProp: 'the total' }),
    ],
    [
      'a time bucket’s unit that is no word of the language',
      () => changed(bucketed(), 'TIME_BUCKET', { unit: 'fortnight' }),
    ],
    [
      'a time bucket’s result name that is not a plain name',
      () => changed(bucketed(), 'TIME_BUCKET', { resultProp: 'the day' }),
    ],
    ['a page whose start is not a number', () => changed(paged(), 'PAGINATION', { start: 'the first' })],
    ['a page whose start is a number written as text', () => changed(paged(), 'PAGINATION', { start: '0' })],
    ['a page whose end is not a whole number', () => changed(paged(), 'PAGINATION', { end: 10.5 })],
    ['a page whose end is not a finite number', () => changed(paged(), 'PAGINATION', { end: Infinity })],
    ['a page whose end is past the whole numbers', () => changed(paged(), 'PAGINATION', { end: 1e300 })],
    ['a page that starts below zero', () => changed(paged(), 'PAGINATION', { start: -1 })],
    ['a page that ends before it starts', () => changed(paged(), 'PAGINATION', { start: 5, end: 4 })],
    ['a table’s name that holds a quote', () => new QueryBuilder<Employee>('Emp`loyee')],
    ['a condition’s field that holds a quote', () => changed(named(), 'CONDITION', { field: 'na`me' })],
    ['an aggregate’s field that holds a quote', () => changed(counted(), 'AGGREGATE', { field: 'a`ge' })],
    ['a group-by’s field that holds a quote', () => employees().groupBy(['na`me' as any])],
    ['a time bucket’s field that holds a quote', () => changed(bucketed(), 'TIME_BUCKET', { field: 'hi`red' })],
    ['a sort’s field that holds a quote', () => employees().sort([{ field: 'na`me' as any }])],
    ['a select’s field that holds a quote', () => employees().select({ fields: ['na`me' as any] })],
    ['a condition’s field that holds a backslash', () => changed(named(), 'CONDITION', { field: 'name\\' })],
    ['a select’s fields that are not a list', () => employees().select({ fields: notAList as any })],
    ['a group-by’s fields that are not a list', () => employees().groupBy(notAList as any)],
    [
      'a sort’s values that are not a list',
      () => changed(sorted(), 'SORT', { criteria: { field: 'name', byValues: notAList } }),
    ],
  ])('%s is refused, and no statement is written', (_what, build) => {
    expect(() => build().toSql(config)).toThrow('no statement was written');
  });

  it('a database’s name that holds a quote is refused, and no statement is written', () => {
    expect(() => named().toSql({ ...config, dbName: 'te`st' })).toThrow('no statement was written');
  });
});
