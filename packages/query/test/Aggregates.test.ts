import { QueryBuilder } from '../src/QueryBuilder';

describe('QueryBuilder - Aggregate Support', () => {
  interface Employee {
    id: number;
    name: string;
    age: number;
    salary: number;
  }

  const dbName = 'test';
  const tableName = 'Employee';

  test('COUNT(field) aggregate function', () => {
    const qb = new QueryBuilder<Employee>(tableName).aggregate({ function: 'COUNT', field: 'id' });

    // Standard SQL output
    let result = qb.toSql({dbName});
    expect(result.sql).toBe('SELECT COUNT(id) FROM test.Employee;');

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toBe('SELECT COUNT(id) FROM test.Employee;');
    expect(result.params).toEqual([]);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toBe('SELECT COUNT(id) FROM test.Employee;');
    expect(result.namedParams?.params).toEqual({});
    expect(result.namedParams?.types).toEqual({});
  });

  test('COUNT(*) as count aggregate function', () => {
    const qb = new QueryBuilder<Employee>(tableName).aggregate({ function: 'COUNT', resultProp: 'count' });

    // Standard SQL output
    let result = qb.toSql({dbName});
    expect(result.sql).toBe('SELECT COUNT(*) as count FROM test.Employee;');

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toBe('SELECT COUNT(*) as count FROM test.Employee;');
    expect(result.params).toEqual([]);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toBe('SELECT COUNT(*) as count FROM test.Employee;');
    expect(result.namedParams?.params).toEqual({});
    expect(result.namedParams?.types).toEqual({});
  });

  test('SUM aggregate function', () => {
    const qb = new QueryBuilder<Employee>(tableName).aggregate({ function: 'SUM', field: 'salary' });

    let result = qb.toSql({dbName});
    expect(result.sql).toBe('SELECT SUM(salary) FROM test.Employee;');

    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toBe('SELECT SUM(salary) FROM test.Employee;');
    expect(result.params).toEqual([]);

    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toBe('SELECT SUM(salary) FROM test.Employee;');
    expect(result.namedParams?.params).toEqual({});
    expect(result.namedParams?.types).toEqual({});
  });

  test('AVG aggregate function', () => {
    const qb = new QueryBuilder<Employee>(tableName).aggregate({ function: 'AVG', field: 'age' });

    let result = qb.toSql({dbName});
    expect(result.sql).toBe('SELECT AVG(age) FROM test.Employee;');

    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toBe('SELECT AVG(age) FROM test.Employee;');
    expect(result.params).toEqual([]);

    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toBe('SELECT AVG(age) FROM test.Employee;');
    expect(result.namedParams?.params).toEqual({});
    expect(result.namedParams?.types).toEqual({});
  });

  test('MIN aggregate function', () => {
    const qb = new QueryBuilder<Employee>(tableName).aggregate({ function: 'MIN', field: 'age' });

    let result = qb.toSql({dbName});
    expect(result.sql).toBe('SELECT MIN(age) FROM test.Employee;');

    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toBe('SELECT MIN(age) FROM test.Employee;');
    expect(result.params).toEqual([]);

    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toBe('SELECT MIN(age) FROM test.Employee;');
    expect(result.namedParams?.params).toEqual({});
    expect(result.namedParams?.types).toEqual({});
  });

  test('MAX aggregate function', () => {
    const qb = new QueryBuilder<Employee>(tableName).aggregate({ function: 'MAX', field: 'age' });

    // Standard SQL output
    let result = qb.toSql({dbName});
    expect(result.sql).toBe('SELECT MAX(age) FROM test.Employee;');

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toBe('SELECT MAX(age) FROM test.Employee;');
    expect(result.params).toEqual([]);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toBe('SELECT MAX(age) FROM test.Employee;');
    expect(result.namedParams?.params).toEqual({});
    expect(result.namedParams?.types).toEqual({});
  });

  test('Multiple aggregate functions', () => {
    const qb = new QueryBuilder<Employee>(tableName)
      .aggregate({ function: 'COUNT', field: 'id' })
      .aggregate({ function: 'AVG', field: 'age' });

    // Standard SQL output
    let result = qb.toSql({dbName});
    expect(result.sql).toBe('SELECT COUNT(id), AVG(age) FROM test.Employee;');

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toBe('SELECT COUNT(id), AVG(age) FROM test.Employee;');
    expect(result.params).toEqual([]);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toBe('SELECT COUNT(id), AVG(age) FROM test.Employee;');
    expect(result.namedParams?.params).toEqual({});
    expect(result.namedParams?.types).toEqual({});
  });

  test('Aggregate function with condition', () => {
    const qb = new QueryBuilder<Employee>(tableName)
      .condition({ field: 'age', operator: '>', value: 30 })
      .aggregate({ function: 'AVG', field: 'salary' });

    // Standard SQL output
    let result = qb.toSql({dbName});
    expect(result.sql).toBe("SELECT AVG(salary) FROM test.Employee WHERE age > 30;");

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toContain("SELECT AVG(salary) FROM test.Employee WHERE age > ?;");
    expect(result.params).toEqual([30]);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain("SELECT AVG(salary) FROM test.Employee WHERE age > @param0;");
    expect(result.namedParams?.params).toEqual({ param0: 30 });
    expect(result.namedParams?.types).toEqual({ param0: 'number' });
  });

  test('Aggregate function with GROUP BY', () => {
    const qb = new QueryBuilder<Employee>(tableName)
      .aggregate({ function: 'SUM', field: 'salary' })
      .groupBy(['age']);

    // Standard SQL output
    let result = qb.toSql({dbName});
    expect(result.sql).toBe("SELECT SUM(salary) FROM test.Employee GROUP BY age;");

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toBe("SELECT SUM(salary) FROM test.Employee GROUP BY age;");
    expect(result.params).toEqual([]);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toBe("SELECT SUM(salary) FROM test.Employee GROUP BY age;");
    expect(result.namedParams?.params).toEqual({});
    expect(result.namedParams?.types).toEqual({});
  });
});
