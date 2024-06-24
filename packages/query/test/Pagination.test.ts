import { QueryBuilder } from '../src/QueryBuilder';

describe('QueryBuilder - Pagination Support', () => {
  interface Employee {
    id: number;
    name: string;
    age: number;
    country: string;
  }

  const dbName = 'test';
  const tableName = 'Employee';

  test('Pagination API', () => {
    const qb = new QueryBuilder<Employee>(tableName)
      .condition({ field: 'country', operator: '=', value: 'USA' })
      .paginate({ start: 10, end: 20 });

    // Standard SQL output with pagination
    let result = qb.toSql({ dbName });
    expect(result.sql).toBe("SELECT * FROM `test`.`Employee` WHERE `country` = 'USA' LIMIT 10 OFFSET 10;");

    // SQL output with positional parameters including pagination
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `country` = ? LIMIT 10 OFFSET 10;');
    expect(result.params).toEqual(['USA']);

    // SQL output with named parameters and types including pagination
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `country` = @param0 LIMIT 10 OFFSET 10;');
    expect(result.namedParams?.params).toEqual({ param0: 'USA' });
    expect(result.namedParams?.types).toEqual({ param0: 'string' });
  });
});
