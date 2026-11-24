import '../generated/index';
import { Graph } from '@proteinjs/util';
import { Serializer } from '@proteinjs/serializer';
import { QueryBuilder } from '../src/QueryBuilder';
import { StatementFactory } from '../src/StatementFactory';

describe('QueryBuilder - Serialization', () => {
  interface Employee {
    id: number;
    department: string;
    salary: number;
    yearsOfExperience: number;
  }

  const dbName = 'test';
  const tableName = 'Employee';

  test('the copy the code makes of a triple-nested subquery is written as its source: query -> subquery -> sub-subquery', () => {
    // Innermost sub-subquery: high-paid Support employees
    const subSubQb = new QueryBuilder<Employee>(tableName).and([
      { field: 'department', operator: '=', value: 'Support' },
      { field: 'salary', operator: '>', value: 70000 },
    ]);

    // Middle subquery: employees with ≥2 years AND whose id is in subSubQb
    const subQb = new QueryBuilder<Employee>(tableName).and([
      { field: 'yearsOfExperience', operator: '>=', value: 2 },
      { field: 'id', operator: 'IN', value: subSubQb },
    ]);

    // Outer (main) query: Engineering employees whose id is in subQb
    const qb = new QueryBuilder<Employee>(tableName).and([
      { field: 'department', operator: '=', value: 'Engineering' },
      { field: 'id', operator: 'IN', value: subQb },
    ]);

    const qbClone = QueryBuilder.fromQueryBuilder(qb, tableName);

    // Standard SQL
    let result = qbClone.toSql({ dbName });
    const expectedSql =
      "SELECT * FROM `test`.`Employee` WHERE (`department` = 'Engineering' AND `id` IN (SELECT * FROM `test`.`Employee` WHERE (`yearsOfExperience` >= 2 AND `id` IN (SELECT * FROM `test`.`Employee` WHERE (`department` = 'Support' AND `salary` > 70000)))));";
    expect(result.sql).toBe(expectedSql);

    // Positional params
    result = qbClone.toSql({ dbName, useParams: true });
    expect(result.sql).toContain(
      'SELECT * FROM `test`.`Employee` WHERE (`department` = ? AND `id` IN (SELECT * FROM `test`.`Employee` WHERE (`yearsOfExperience` >= ? AND `id` IN (SELECT * FROM `test`.`Employee` WHERE (`department` = ? AND `salary` > ?)))));'
    );
    expect(result.params).toEqual(['Engineering', 2, 'Support', 70000]);

    // Named params with types — align to your nested prefixing scheme (sq0 for middle, sq0_sq0 for inner)
    result = qbClone.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain(
      'SELECT * FROM `test`.`Employee` WHERE (`department` = @param0 AND `id` IN (SELECT * FROM `test`.`Employee` WHERE (`yearsOfExperience` >= @sq0_param0 AND `id` IN (SELECT * FROM `test`.`Employee` WHERE (`department` = @sq0_sq0_param0 AND `salary` > @sq0_sq0_param1)))));'
    );
    expect(result.namedParams?.params).toEqual({
      param0: 'Engineering', // outer
      sq0_param0: 2, // middle (yearsOfExperience)
      sq0_sq0_param0: 'Support', // inner (department)
      sq0_sq0_param1: 70000, // inner (salary)
    });
    expect(result.namedParams?.types).toEqual({
      param0: 'string',
      sq0_param0: 'number',
      sq0_sq0_param0: 'string',
      sq0_sq0_param1: 'number',
    });
  });
});

/**
 * A statement is written from a builder the running code made. A builder read from a text is a description
 * of a query, and data: no statement is written from it, and it is never written inside another statement,
 * wherever it turns up as a value. Whoever runs a described query first makes the code's own builder of it
 * (`QueryBuilder.rebuiltFrom`, the next block). The copy the code makes of a builder it holds
 * (`fromQueryBuilder`) is marked, query for query, as its source is.
 */
describe('a statement is written from a builder the running code made', () => {
  interface Employee {
    id: number;
    department: string;
    salary: number;
    yearsOfExperience: number;
  }

  const dbName = 'test';
  const tableName = 'Employee';
  const config = { dbName, useParams: true };
  const refusal = 'no statement was written';
  /** A builder as a text carries it and a reader of the text receives it. */
  const read = (qb: QueryBuilder<Employee>): QueryBuilder<Employee> => Serializer.deserialize(Serializer.serialize(qb));
  const employees = () => new QueryBuilder<Employee>(tableName);
  const ofSupport = () =>
    employees()
      .select({ fields: ['id'] })
      .condition({ field: 'department', operator: '=', value: 'Support' });
  const written = '(SELECT `id` FROM `test`.`Employee` WHERE `department` = ?)';

  it('no statement is written from a builder read from a text', () => {
    expect(() => read(ofSupport()).toSql(config)).toThrow(refusal);
    expect(() => read(ofSupport()).toWhereClause(config)).toThrow(refusal);
    expect(ofSupport().toSql(config).sql).toBe('SELECT `id` FROM `test`.`Employee` WHERE `department` = ?;');
  });

  it.each<[string, (inner: QueryBuilder<Employee>) => QueryBuilder<Employee>]>([
    ['as a condition’s value', (inner) => employees().condition({ field: 'id', operator: 'IN', value: inner })],
    [
      'in a condition’s list of values',
      (inner) => employees().condition({ field: 'id', operator: 'IN', value: [1, inner] as any }),
    ],
    [
      'between two values',
      (inner) => employees().condition({ field: 'salary', operator: 'BETWEEN', value: [1, inner] as any }),
    ],
    ['in a sort’s values', (inner) => employees().sort([{ field: 'id', byValues: [inner] as any }])],
  ])('a builder read from a text is not written into a statement %s; the code’s own is', (_where, holding) => {
    expect(() => holding(read(ofSupport())).toSql(config)).toThrow(refusal);
    expect(holding(ofSupport()).toSql(config).sql).toContain(written);
  });

  it('a builder read from a text is not written as a value of a row that is inserted or updated', () => {
    const statements = new StatementFactory<Employee>();
    const row = () => ({ department: read(ofSupport()) as unknown as string });
    const one = employees().condition({ field: 'id', operator: '=', value: 1 });
    expect(() => statements.insert(tableName, row(), config)).toThrow(refusal);
    expect(() => statements.insertMany(tableName, [row()], config)).toThrow(refusal);
    expect(() => statements.update(tableName, row(), one, config)).toThrow(refusal);
  });

  it('the copy the code makes of its own query writes every query inside it, as its source does', () => {
    const own = employees()
      .condition({ field: 'id', operator: 'IN', value: ofSupport() })
      .sort([{ field: 'id', byValues: [ofSupport()] as any }]);
    const copy = QueryBuilder.fromQueryBuilder(own, tableName);
    expect(copy.toSql(config)).toEqual(own.toSql(config));
    expect(copy.toSql(config).sql.split(written).length).toBe(3);
  });

  it('a copy of what was read is read: the copy of a read builder, and a read query inside a copy', () => {
    const copyOfRead = QueryBuilder.fromQueryBuilder(read(ofSupport()), tableName);
    expect(() => copyOfRead.toSql(config)).toThrow(refusal);
    expect(() => employees().condition({ field: 'id', operator: 'IN', value: copyOfRead }).toSql(config)).toThrow(
      refusal
    );

    const holdingRead = employees().condition({ field: 'id', operator: 'IN', value: read(ofSupport()) });
    expect(() => QueryBuilder.fromQueryBuilder(holdingRead, tableName).toSql(config)).toThrow(refusal);
  });

  it('the mark of a builder read from a text is not among its fields', () => {
    const readBuilder = read(ofSupport());
    expect(readBuilder.wasReadFromText()).toBe(true);
    expect(Object.keys(readBuilder)).not.toContain('__readFromText');
  });

  it('a builder read from a text is read whatever is laid over its mark', () => {
    const laidOver = Object.create(read(ofSupport()));
    Object.defineProperty(laidOver, '__readFromText', { value: false, enumerable: true });
    expect(() => employees().condition({ field: 'id', operator: 'IN', value: laidOver }).toSql(config)).toThrow(
      refusal
    );
  });

  it('a builder made by a copy of this package that keeps no such mark is not written into a statement', () => {
    // What an earlier copy of this package made: a builder that keeps no mark.
    const madeElsewhere = (() => {
      class QueryBuilder {
        tableName = tableName;
        toSql() {
          return { sql: 'SELECT 1;' };
        }
      }
      return new QueryBuilder();
    })();
    expect(() =>
      employees()
        .condition({ field: 'id', operator: 'IN', value: madeElsewhere as any })
        .toSql({ dbName })
    ).toThrow(refusal);
  });
});

/**
 * `QueryBuilder.rebuiltFrom`: the running code's own builder of the query a builder read from a text
 * describes. The description is read part by part from its root, into a builder the code makes; nothing is
 * added to the description itself. What the rebuild writes is what the described query's own builder writes;
 * what a description holds beyond the parts of a query is not carried over; a description this class could
 * not have written is refused.
 */
describe('the rebuild of a builder read from a text', () => {
  interface Employee {
    id: number;
    name: string;
    department: string;
    salary: number;
    age: number;
    hired: number;
  }
  interface Department {
    name: string;
    open: boolean;
  }

  const dbName = 'test';
  const tableName = 'Employee';
  const dateTruncExpression = (col: string, unit: string) => `TIMESTAMP_TRUNC(${col}, ${unit}, 'UTC')`;
  const configs = [
    { dbName, dateTruncExpression },
    { dbName, useParams: true, dateTruncExpression },
    { dbName, useParams: true, useNamedParams: true, dateTruncExpression },
    // A driver that folds case: a condition that is not case sensitive is written another way.
    {
      dbName,
      useParams: true,
      dateTruncExpression,
      resolveFieldName: (_table: string, field: string) => field,
      handleCaseSensitivity: (_table: string, column: string, caseSensitive: boolean) =>
        caseSensitive ? column : `LOWER(${column})`,
    },
  ];
  const read = <T>(qb: QueryBuilder<T>): QueryBuilder<T> => Serializer.deserialize(Serializer.serialize(qb));
  const employees = () => new QueryBuilder<Employee>(tableName);
  const openDepartments = () =>
    new QueryBuilder<Department>('Department')
      .select({ fields: ['name'] })
      .condition({ field: 'open', operator: '=', value: true });
  const inOpenDepartments = () =>
    employees()
      .select({ fields: ['id'] })
      .condition({ field: 'department', operator: 'IN', value: openDepartments() });
  const none = () => undefined;

  it.each<[string, () => QueryBuilder<Employee>]>([
    [
      'conditions of every shape',
      () =>
        employees()
          .condition({ field: 'name', operator: '=', value: 'Ada' })
          .condition({ field: 'department', operator: 'LIKE', value: 'Eng%' }, undefined, false)
          .condition({ field: 'salary', operator: 'BETWEEN', value: [1, 2] as any })
          .condition({ field: 'id', operator: 'IN', value: [1, 2, 3] as any })
          .condition({ field: 'id', operator: 'NOT IN', value: [] as any })
          .condition({ field: 'department', operator: 'IS NULL' })
          .condition({ field: 'age', operator: '=', value: null as any }),
    ],
    [
      'groups within groups',
      () =>
        employees().and([
          { field: 'name', operator: '=', value: 'Ada' },
          {
            operator: 'OR',
            children: [
              { field: 'age', operator: '>', value: 30 },
              { field: 'age', operator: 'IS NULL' },
            ],
          },
        ]),
    ],
    [
      'a select, two sorts and a page',
      () =>
        employees()
          .select({ fields: ['id', 'name'] })
          .sort([
            { field: 'department', byValues: ['Support', 'Sales'] as any },
            { field: 'name', desc: true },
          ])
          .paginate({ start: 20, end: 30 }),
    ],
    [
      'aggregates over a group and a time bucket',
      () =>
        employees()
          .aggregate({ function: 'SUM', field: 'salary', resultProp: 'total' })
          .aggregate({ function: 'COUNT' })
          .groupBy(['department'])
          .timeBucket({ field: 'hired', unit: 'day', resultProp: 'day' }),
    ],
    [
      'queries inside queries, two deep',
      () => employees().condition({ field: 'id', operator: 'IN', value: inOpenDepartments() }),
    ],
  ])('the rebuild of %s writes the statement the described query writes', (_what, described) => {
    for (const config of configs) {
      expect(QueryBuilder.rebuiltFrom(read(described()), none).toSql(config)).toEqual(described().toSql(config));
    }
  });

  it('each query inside a description is rebuilt too, and handed to whoever runs the whole', () => {
    const within: QueryBuilder<any>[] = [];
    const rebuilt = QueryBuilder.rebuiltFrom(
      read(employees().condition({ field: 'id', operator: 'IN', value: inOpenDepartments() })),
      (query) => within.push(query)
    );
    expect(within.map((query) => query.tableName)).toEqual(['Department', tableName]);
    expect([rebuilt, ...within].every((query) => QueryBuilder.isTheCodesOwn(query))).toBe(true);

    // What the one who runs it adds to a query within is written with it.
    within[1].condition({ field: 'age', operator: '>', value: 1 });
    expect(rebuilt.toSql({ dbName, useParams: true }).sql).toBe(
      'SELECT * FROM `test`.`Employee` WHERE `id` IN (SELECT `id` FROM `test`.`Employee` WHERE `department` IN (SELECT `name` FROM `test`.`Department` WHERE `open` = ?) AND `age` > ?);'
    );
  });

  it('a query the running code put inside a builder it was handed stays as it is', () => {
    const handed = read(employees().condition({ field: 'name', operator: '=', value: 'Ada' }));
    const theCodes = openDepartments();
    handed.condition({ field: 'department', operator: 'IN', value: theCodes });
    const within: QueryBuilder<any>[] = [];
    const rebuilt = QueryBuilder.rebuiltFrom(handed, (query) => within.push(query));
    expect(within).toEqual([]);
    expect((rebuilt.graph.node('node_1') as any).value).toBe(theCodes);
  });

  it('what is added to a rebuilt builder is all written, whatever counter and bookkeeping the description held', () => {
    const description: any = read(
      employees().condition({ field: 'name', operator: '=', value: 'Ada' }).paginate({ start: 0, end: 9 })
    );
    description.idCounter = 'x';
    description.currentContextIds = ['node_0', 'node_1', 'node_0', '__proto__', 5];
    description.paginationNodeId = 'nowhere';
    const rebuilt = QueryBuilder.rebuiltFrom<Employee>(description, none);
    // The rebuilt builder has chained nothing yet: its list of contexts is its own, and empty.
    expect(rebuilt.currentContextIds).toHaveLength(0);

    rebuilt
      .or([rebuilt.condition({ field: 'age', operator: '>', value: 1 }), { field: 'age', operator: '<', value: 0 }])
      .condition({ field: 'department', operator: '=', value: 'Support' })
      .paginate({ start: 0, end: 5 });
    expect(rebuilt.toSql({ dbName }).sql).toBe(
      "SELECT * FROM `test`.`Employee` WHERE `name` = 'Ada' AND (`age` < 0 OR `age` > 1) AND `department` = 'Support' LIMIT 5 OFFSET 0;"
    );
    // The page it was given took the place of the page the description held.
    const pages = rebuilt.graph.nodes().filter((id: string) => (rebuilt.graph.node(id) as any).type === 'PAGINATION');
    expect(pages).toHaveLength(1);
  });

  it('a builder says which rows and nothing else when it holds conditions and groups alone', () => {
    const rows = () =>
      employees()
        .condition({ field: 'name', operator: '=', value: 'Ada' })
        .or([
          { field: 'age', operator: '>', value: 30 },
          { field: 'department', operator: 'IN', value: openDepartments() as any },
        ]);
    expect(employees().saysOnlyWhichRows()).toBe(true);
    expect(rows().saysOnlyWhichRows()).toBe(true);
    expect(QueryBuilder.rebuiltFrom(read(rows()), none).saysOnlyWhichRows()).toBe(true);

    const sayingMore = [
      rows().select({ fields: ['id'] }),
      rows().aggregate({ function: 'MAX', field: 'name', resultProp: 'latest' }),
      rows().groupBy(['department']),
      rows().timeBucket({ field: 'hired', unit: 'day', resultProp: 'day' }),
      rows().sort([{ field: 'name' }]),
      rows().paginate({ start: 0, end: 1 }),
    ];
    for (const query of sayingMore) {
      expect(query.saysOnlyWhichRows()).toBe(false);
      expect(QueryBuilder.rebuiltFrom(read(query), none).saysOnlyWhichRows()).toBe(false);
    }
  });

  it('a part the description does not hold under its root is not carried over', () => {
    const description = read(employees().condition({ field: 'name', operator: '=', value: 'Ada' }));
    description.graph.setNode('apart', {
      type: 'CONDITION',
      field: 'salary',
      operator: '>',
      value: 0,
      caseSensitive: true,
    });
    const rebuilt = QueryBuilder.rebuiltFrom(description, none);
    expect(rebuilt.graph.nodes()).toEqual(['root', 'node_0']);
    expect(rebuilt.toSql({ dbName }).sql).toBe("SELECT * FROM `test`.`Employee` WHERE `name` = 'Ada';");
  });

  it('a part is rebuilt whatever name the description gave it', () => {
    const description = read(employees().condition({ field: 'name', operator: '=', value: 'Ada' }));
    description.graph.setNode('constructor', {
      type: 'CONDITION',
      field: 'salary',
      operator: '>',
      value: 0,
      caseSensitive: true,
    });
    description.graph.setEdge('root', 'constructor');
    expect(QueryBuilder.rebuiltFrom(description, none).toSql({ dbName }).sql).toBe(
      "SELECT * FROM `test`.`Employee` WHERE `name` = 'Ada' AND `salary` > 0;"
    );
  });

  /** A description with one part of each kind, to be changed into one no builder writes. */
  const described = (): any =>
    read(
      employees()
        .select({ fields: ['id'] })
        .or([
          { field: 'name', operator: '=', value: 'Ada' },
          { field: 'age', operator: '>', value: 30 },
        ])
        .groupBy(['department'])
        .sort([{ field: 'name', byValues: ['Ada'] as any }])
        .condition({ field: 'salary', operator: '<', value: 99 })
        .aggregate({ function: 'COUNT', field: 'id', resultProp: 'total' })
        .timeBucket({ field: 'hired', unit: 'day', resultProp: 'day' })
        .paginate({ start: 0, end: 5 })
    );
  const partOf = (description: any, type: string): string =>
    description.graph.nodes().find((id: string) => description.graph.node(id)?.type === type);
  const changed = (description: any, type: string, change: { [field: string]: unknown }): void => {
    const id = partOf(description, type);
    description.graph.setNode(id, { ...description.graph.node(id), ...change });
  };
  /** Answers to `map`, as a list does, and is not one. */
  const notAList = { length: 1, 0: 'name', map: Array.prototype.map };

  it.each<[string, (description: any) => void]>([
    ['names no table', (description) => (description.tableName = '')],
    ['names its table by something that is not a name', (description) => (description.tableName = ['Employee'])],
    ['is rooted at a part that is not a builder’s root', (description) => (description.rootId = 'node_0')],
    ['is rooted at a name every object answers to', (description) => (description.rootId = '__proto__')],
    ['is rooted at something that is not a name', (description) => (description.rootId = { value: 5 })],
    ['holds something that is not a graph', (description) => (description.graph = { nodes: [], edges: [] })],
    [
      'holds a graph that has no directions',
      (description) => {
        const undirected = new Graph({ directed: false });
        description.graph.nodes().forEach((id: string) => undirected.setNode(id, description.graph.node(id)));
        description.graph.edges().forEach((edge: { v: string; w: string }) => undirected.setEdge(edge.v, edge.w));
        description.graph = undirected;
      },
    ],
    [
      'holds one part under two',
      (description) =>
        description.graph.setEdge(
          partOf(description, 'LOGICAL'),
          description.graph.nodes().find((id: string) => description.graph.node(id)?.field === 'salary')
        ),
    ],
    ['holds a part of no kind a query has', (description) => changed(description, 'SELECT', { type: 'ANOTHER' })],
    [
      'holds a part whose fields are not its own',
      (description) =>
        description.graph.setNode(partOf(description, 'SELECT'), Object.create({ type: 'SELECT', fields: ['id'] })),
    ],
    [
      'holds, in a group, a part that is neither a condition nor a group',
      (description) => {
        description.graph.setNode('page', { type: 'PAGINATION', start: 0, end: 1 });
        description.graph.setEdge(partOf(description, 'LOGICAL'), 'page');
      },
    ],
    [
      'holds a select whose fields are not a list',
      (description) => changed(description, 'SELECT', { fields: notAList }),
    ],
    ['holds a select whose field is not text', (description) => changed(description, 'SELECT', { fields: [5] })],
    [
      'holds a group-by whose fields are not a list',
      (description) => changed(description, 'GROUP_BY', { fields: notAList }),
    ],
    [
      'holds a sort whose values are not a list',
      (description) => changed(description, 'SORT', { criteria: { field: 'name', byValues: notAList } }),
    ],
    ['holds a sort with no field', (description) => changed(description, 'SORT', { criteria: { byValues: [] } })],
    ['holds a condition whose field is not text', (description) => changed(description, 'CONDITION', { field: 5 })],
    [
      'holds a condition whose operator is no word of the language',
      (description) => changed(description, 'CONDITION', { operator: 'RESEMBLES' }),
    ],
    [
      'holds a group whose operator is no word of the language',
      (description) => changed(description, 'LOGICAL', { operator: 'XOR' }),
    ],
    [
      'holds an aggregate whose function is no word of the language',
      (description) => changed(description, 'AGGREGATE', { function: 'MEDIAN' }),
    ],
    [
      'holds an aggregate whose result name is not a plain name',
      (description) => changed(description, 'AGGREGATE', { resultProp: 'the total' }),
    ],
    ['holds an aggregate with no field', (description) => changed(description, 'AGGREGATE', { field: undefined })],
    [
      'holds a time bucket whose unit is no word of the language',
      (description) => changed(description, 'TIME_BUCKET', { unit: 'fortnight' }),
    ],
    [
      'holds a time bucket whose result name is not a plain name',
      (description) => changed(description, 'TIME_BUCKET', { resultProp: 'the day' }),
    ],
    ['holds a time bucket with no field', (description) => changed(description, 'TIME_BUCKET', { field: undefined })],
    ['holds a page that is not two whole numbers', (description) => changed(description, 'PAGINATION', { end: 2.5 })],
  ])('a description that %s is not rebuilt', (_what, change) => {
    const description = described();
    change(description);
    expect(() => QueryBuilder.rebuiltFrom(description, none)).toThrow(/no query was built|no statement was written/);
  });
});
