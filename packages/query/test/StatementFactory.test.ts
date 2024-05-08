import { QueryBuilder } from '../src/QueryBuilder';
import { StatementFactory } from '../src/StatementFactory';

describe('StatementFactory', () => {
  interface Employee {
    id: number;
    name: string;
    age: number;
    country: string;
  }

  const dbName = 'test';
  const tableName = 'Employee';

  test('Insert Statement', () => {
    const data: Partial<Employee> = { name: 'John Doe', age: 30, country: 'USA' };
    const factory = new StatementFactory<Employee>();

    // Standard SQL output without parameterization
    let result = factory.insert(tableName, data, { dbName });
    expect(result.sql).toBe("INSERT INTO test.Employee (name, age, country) VALUES ('John Doe', 30, 'USA');");

    // SQL output with positional parameters
    result = factory.insert(tableName, data, { dbName, useParams: true });
    expect(result.sql).toContain('INSERT INTO test.Employee (name, age, country) VALUES (?, ?, ?);');
    expect(result.params).toEqual(['John Doe', 30, 'USA']);

    // SQL output with named parameters
    result = factory.insert(tableName, data, { dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain('INSERT INTO test.Employee (name, age, country) VALUES (@param0, @param1, @param2);');
    expect(result.namedParams?.params).toEqual({ param0: 'John Doe', param1: 30, param2: 'USA' });
    expect(result.namedParams?.types).toEqual({ param0: 'string', param1: 'number', param2: 'string' });
  });

  test('Update Statement', () => {
    const data: Partial<Employee> = { age: 31 };
    const factory = new StatementFactory<Employee>();
    const queryBuilder = new QueryBuilder<Employee>(tableName).condition({
      field: 'name',
      operator: '=',
      value: 'John Doe',
    });

    // Standard SQL output without parameterization
    let result = factory.update(tableName, data, queryBuilder, { dbName });
    expect(result.sql).toBe("UPDATE test.Employee SET age = 31 WHERE name = 'John Doe';");

    // SQL output with positional parameters
    result = factory.update(tableName, data, queryBuilder, { dbName, useParams: true });
    expect(result.sql).toContain('UPDATE test.Employee SET age = ? WHERE name = ?;');
    expect(result.params).toEqual([31, 'John Doe']);

    // SQL output with named parameters
    result = factory.update(tableName, data, queryBuilder, { dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain('UPDATE test.Employee SET age = @param0 WHERE name = @param1;');
    expect(result.namedParams?.params).toEqual({ param0: 31, param1: 'John Doe' });
    expect(result.namedParams?.types).toEqual({ param0: 'number', param1: 'string' });
  });

  test('Delete Statement', () => {
    const factory = new StatementFactory<Employee>();
    const queryBuilder = new QueryBuilder<Employee>(tableName).condition({
      field: 'country',
      operator: '=',
      value: 'USA',
    });

    // Standard SQL output without parameterization
    let result = factory.delete(tableName, queryBuilder, { dbName });
    expect(result.sql).toBe("DELETE FROM test.Employee WHERE country = 'USA';");

    // SQL output with positional parameters
    result = factory.delete(tableName, queryBuilder, { dbName, useParams: true });
    expect(result.sql).toContain('DELETE FROM test.Employee WHERE country = ?;');
    expect(result.params).toEqual(['USA']);

    // SQL output with named parameters
    result = factory.delete(tableName, queryBuilder, { dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain('DELETE FROM test.Employee WHERE country = @param0;');
    expect(result.namedParams?.params).toEqual({ param0: 'USA' });
    expect(result.namedParams?.types).toEqual({ param0: 'string' });
  });
});
