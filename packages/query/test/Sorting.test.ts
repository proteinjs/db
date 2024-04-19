import { QueryBuilder } from '../src/QueryBuilder';

describe('QueryBuilder - Sorting Support', () => {
  interface Employee {
    id: number;
    name: string;
    age: number;
    country: string;
  }

  const dbName = 'test';
  const tableName = 'Employee';

  test('Basic sorting', () => {
    const qb = new QueryBuilder<Employee>(tableName)
      .condition({ field: 'country', operator: '=', value: 'USA' })
      .sort([
        { field: 'age', desc: true },
        { field: 'name', desc: false }
      ]);

    // Standard SQL output
    let result = qb.toSql({dbName});
    expect(result.sql).toBe("SELECT * FROM test.Employee WHERE country = 'USA' ORDER BY age DESC, name ASC;");

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toContain("SELECT * FROM test.Employee WHERE country = ? ORDER BY age DESC, name ASC;");
    expect(result.params).toEqual(['USA']);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain("SELECT * FROM test.Employee WHERE country = @param0 ORDER BY age DESC, name ASC;");
    expect(result.namedParams?.params).toEqual({ param0: 'USA' });
    expect(result.namedParams?.types).toEqual({ param0: 'string' });
  });

  test('Sorting by values', () => {
    const qb = new QueryBuilder<Employee>(tableName)
      .condition({ field: 'country', operator: '=', value: 'USA' })
      .sort([
        { field: 'name', byValues: ['John', 'Doe', 'Smith'] }
      ]);

    // Standard SQL output
    let result = qb.toSql({dbName});
    expect(result.sql).toBe("SELECT * FROM test.Employee WHERE country = 'USA' ORDER BY CASE WHEN name = 'John' THEN 0 WHEN name = 'Doe' THEN 1 WHEN name = 'Smith' THEN 2 ELSE 3 END ASC;");

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toContain("SELECT * FROM test.Employee WHERE country = ? ORDER BY CASE WHEN name = ? THEN 0 WHEN name = ? THEN 1 WHEN name = ? THEN 2 ELSE 3 END ASC;");
    expect(result.params).toEqual(['USA', 'John', 'Doe', 'Smith']);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain("SELECT * FROM test.Employee WHERE country = @param0 ORDER BY CASE WHEN name = @param1 THEN 0 WHEN name = @param2 THEN 1 WHEN name = @param3 THEN 2 ELSE 3 END ASC;");
    expect(result.namedParams?.params).toEqual({ param0: 'USA', param1: 'John', param2: 'Doe', param3: 'Smith' });
    expect(result.namedParams?.types).toEqual({ param0: 'string', param1: 'string', param2: 'string', param3: 'string' });
  });
});
