import { QueryBuilder, Operator } from '../src/QueryBuilder';

describe('QueryBuilder - Conditional Operator Support', () => {
  interface Employee {
    id: number;
    name: string;
    age: number;
    country: string;
  }

  const dbName = 'test';
  const tableName = 'Employee';

  test('= operator', () => {
    const qb = new QueryBuilder<Employee>(tableName).condition({ field: 'id', operator: '=', value: 1 });

    // Standard SQL output
    let result = qb.toSql({ dbName });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE `id` = 1;');

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `id` = ?');
    expect(result.params).toEqual([1]);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `id` = @param0');
    expect(result.namedParams?.params).toEqual({ param0: 1 });
    expect(result.namedParams?.types).toEqual({ param0: 'number' });

    // Error thrown with undefined value passed in
    expect(() => {
      new QueryBuilder<Employee>(tableName)
        .condition({ field: 'id', operator: '=', value: undefined })
        .toSql({ dbName });
    }).toThrow();

    // Operator '=' with null is properly converted to IS NULL
    const qbNull = new QueryBuilder<Employee>(tableName).condition({ field: 'id', operator: '=', value: null });
    result = qbNull.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `id` IS NULL');
    expect(result.namedParams?.params).toEqual({});
    expect(result.namedParams?.types).toEqual({});
  });

  ['<>', '!='].forEach((operator) => {
    test(`${operator} operator`, () => {
      const value = 'John';
      const qb = new QueryBuilder<Employee>(tableName).condition({
        field: 'name',
        operator: operator as Operator,
        value,
      });

      // Standard SQL output
      let result = qb.toSql({ dbName });
      expect(result.sql).toBe(`SELECT * FROM \`test\`.\`Employee\` WHERE \`name\` ${operator} '${value}';`);

      // SQL output with positional parameters
      result = qb.toSql({ dbName, useParams: true });
      expect(result.sql).toContain(`SELECT * FROM \`test\`.\`Employee\` WHERE \`name\` ${operator} ?`);
      expect(result.params).toEqual([value]);

      // SQL output with named parameters and types
      result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
      expect(result.sql).toContain(`SELECT * FROM \`test\`.\`Employee\` WHERE \`name\` ${operator} @param0`);
      expect(result.namedParams?.params).toEqual({ param0: value });
      expect(result.namedParams?.types).toEqual({ param0: 'string' });
    });
  });

  [
    ['>', 18],
    ['<', 65],
    ['>=', 18],
    ['<=', 65],
  ].forEach(([operator, value]) => {
    test(`${operator} operator`, () => {
      const qb = new QueryBuilder<Employee>(tableName).condition({
        field: 'age',
        operator: operator as Operator,
        value,
      });

      // Standard SQL output
      let result = qb.toSql({ dbName });
      expect(result.sql).toBe(`SELECT * FROM \`test\`.\`Employee\` WHERE \`age\` ${operator} ${value};`);

      // SQL output with positional parameters
      result = qb.toSql({ dbName, useParams: true });
      expect(result.sql).toContain(`SELECT * FROM \`test\`.\`Employee\` WHERE \`age\` ${operator} ?`);
      expect(result.params).toEqual([value]);

      // SQL output with named parameters and types
      result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
      expect(result.sql).toContain(`SELECT * FROM \`test\`.\`Employee\` WHERE \`age\` ${operator} @param0`);
      expect(result.namedParams?.params).toEqual({ param0: value });
      expect(result.namedParams?.types).toEqual({ param0: 'number' });
    });
  });

  test('NOT operator', () => {
    const qb = new QueryBuilder<Employee>(tableName).condition({ field: 'country', operator: 'NOT', value: 'Canada' });

    // Standard SQL output
    let result = qb.toSql({ dbName });
    expect(result.sql).toBe("SELECT * FROM `test`.`Employee` WHERE `country` NOT 'Canada';");

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `country` NOT ?');
    expect(result.params).toEqual(['Canada']);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `country` NOT @param0');
    expect(result.namedParams?.params).toEqual({ param0: 'Canada' });
    expect(result.namedParams?.types).toEqual({ param0: 'string' });

    const qbOr = new QueryBuilder<Employee>(tableName)
      .condition({ field: 'country', operator: 'NOT', value: 'Canada' })
      .logicalGroup('OR', [
        { field: 'age', operator: '=', value: 25 },
        { field: 'age', operator: '=', value: 30 },
      ]);

    // Standard SQL output with NOT and OR conditions
    result = qbOr.toSql({ dbName });
    expect(result.sql).toBe(
      "SELECT * FROM `test`.`Employee` WHERE `country` NOT 'Canada' AND (`age` = 25 OR `age` = 30);"
    );

    // SQL output with positional parameters with NOT and OR conditions
    result = qbOr.toSql({ dbName, useParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `country` NOT ? AND (`age` = ? OR `age` = ?)');
    expect(result.params).toEqual(['Canada', 25, 30]);

    // SQL output with named parameters and types with NOT and OR conditions
    result = qbOr.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain(
      'SELECT * FROM `test`.`Employee` WHERE `country` NOT @param0 AND (`age` = @param1 OR `age` = @param2)'
    );
    expect(result.namedParams?.params).toEqual({ param0: 'Canada', param1: 25, param2: 30 });
    expect(result.namedParams?.types).toEqual({ param0: 'string', param1: 'number', param2: 'number' });

    // Undefined value should throw an error
    expect(() => {
      new QueryBuilder<Employee>(tableName)
        .condition({ field: 'country', operator: 'NOT', value: undefined })
        .toSql({ dbName });
    }).toThrow();
  });

  test('IN operator', () => {
    const qb = new QueryBuilder<Employee>(tableName).condition({ field: 'id', operator: 'IN', value: [1, 2, 3] });

    // Standard SQL output
    let result = qb.toSql({ dbName });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE `id` IN (1, 2, 3);');

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `id` IN (?, ?, ?)');
    expect(result.params).toEqual([1, 2, 3]);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `id` IN UNNEST(@param0)');
    expect(result.namedParams?.params).toEqual({ param0: [1, 2, 3] });
    expect(result.namedParams?.types).toEqual({ param0: { type: 'array', child: { type: 'number' } } });
  });

  test('LIKE operator', () => {
    const qb = new QueryBuilder<Employee>(tableName).condition({ field: 'name', operator: 'LIKE', value: '%John%' });

    // Standard SQL output
    let result = qb.toSql({ dbName });
    expect(result.sql).toBe("SELECT * FROM `test`.`Employee` WHERE `name` LIKE '%John%';");

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `name` LIKE ?');
    expect(result.params).toEqual(['%John%']);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `name` LIKE @param0');
    expect(result.namedParams?.params).toEqual({ param0: '%John%' });
    expect(result.namedParams?.types).toEqual({ param0: 'string' });

    // Undefined value should throw error
    expect(() => {
      new QueryBuilder<Employee>(tableName)
        .condition({ field: 'name', operator: 'LIKE', value: undefined })
        .toSql({ dbName });
    }).toThrow();
  });

  test('NOT LIKE operator', () => {
    const qb = new QueryBuilder<Employee>(tableName).condition({
      field: 'name',
      operator: 'NOT LIKE',
      value: '%John%',
    });

    // Standard SQL output
    let result = qb.toSql({ dbName });
    expect(result.sql).toBe("SELECT * FROM `test`.`Employee` WHERE `name` NOT LIKE '%John%';");

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `name` NOT LIKE ?');
    expect(result.params).toEqual(['%John%']);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `name` NOT LIKE @param0');
    expect(result.namedParams?.params).toEqual({ param0: '%John%' });
    expect(result.namedParams?.types).toEqual({ param0: 'string' });

    // Undefined value should throw an error
    expect(() => {
      new QueryBuilder<Employee>(tableName)
        .condition({ field: 'name', operator: 'NOT LIKE', value: undefined })
        .toSql({ dbName });
    }).toThrow();
  });

  test('BETWEEN operator', () => {
    const qb = new QueryBuilder<Employee>(tableName).condition({ field: 'age', operator: 'BETWEEN', value: [18, 30] });

    // Standard SQL output
    let result = qb.toSql({ dbName });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE `age` BETWEEN 18 AND 30;');

    // SQL output with positional parameters
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `age` BETWEEN ? AND ?');
    expect(result.params).toEqual([18, 30]);

    // SQL output with named parameters and types
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain('SELECT * FROM `test`.`Employee` WHERE `age` BETWEEN @param0 AND @param1');
    expect(result.namedParams?.params).toEqual({ param0: 18, param1: 30 });
    expect(result.namedParams?.types).toEqual({ param0: 'number', param1: 'number' });

    // Undefined value should throw error
    expect(() => {
      new QueryBuilder<Employee>(tableName)
        .condition({ field: 'age', operator: 'BETWEEN', value: undefined })
        .toSql({ dbName });
    }).toThrow();
  });

  test('IS NULL operator', () => {
    const qb = new QueryBuilder<Employee>(tableName).condition({ field: 'country', operator: 'IS NULL' });

    // Standard SQL output
    let result = qb.toSql({ dbName });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE `country` IS NULL;');

    // SQL output with positional parameters (This should remain the same as IS NULL doesn't use parameters)
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE `country` IS NULL;');
    expect(result.params).toEqual([]);

    // SQL output with named parameters and types (Named params don't apply to IS NULL, but included for consistency)
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE `country` IS NULL;');
    // No namedParams should be added for IS NULL
    expect(result.namedParams?.params).toEqual({});
    expect(result.namedParams?.types).toEqual({});
  });

  test('IS NOT NULL operator', () => {
    const qb = new QueryBuilder<Employee>(tableName).condition({ field: 'country', operator: 'IS NOT NULL' });

    // Standard SQL output
    let result = qb.toSql({ dbName });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE `country` IS NOT NULL;');

    // SQL output with positional parameters (This should remain the same as IS NOT NULL doesn't use parameters)
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE `country` IS NOT NULL;');
    expect(result.params).toEqual([]);

    // SQL output with named parameters and types (Named params don't apply to IS NOT NULL, but included for consistency)
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE `country` IS NOT NULL;');
    // No namedParams should be added for IS NOT NULL
    expect(result.namedParams?.params).toEqual({});
    expect(result.namedParams?.types).toEqual({});
  });

  test('Empty array condition value simplifies to 1=0', () => {
    const qb = new QueryBuilder<Employee>(tableName).condition({ field: 'id', operator: 'IN', value: [] });

    // Standard SQL output
    let result = qb.toSql({ dbName });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE 1=0;');

    // SQL output with positional parameters (This should remain the same as IS NOT NULL doesn't use parameters)
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE 1=0;');
    expect(result.params).toEqual([]);

    // SQL output with named parameters and types (Named params don't apply to IS NOT NULL, but included for consistency)
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE 1=0;');
    // No namedParams should be added for IS NOT NULL
    expect(result.namedParams?.params).toEqual({});
    expect(result.namedParams?.types).toEqual({});
  });

  test('Undefined array condition value simplifies to 1=0', () => {
    const qb = new QueryBuilder<Employee>(tableName).condition({ field: 'id', operator: 'IN' });

    // Standard SQL output
    let result = qb.toSql({ dbName });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE 1=0;');

    // SQL output with positional parameters (This should remain the same as IS NOT NULL doesn't use parameters)
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE 1=0;');
    expect(result.params).toEqual([]);

    // SQL output with named parameters and types (Named params don't apply to IS NOT NULL, but included for consistency)
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toBe('SELECT * FROM `test`.`Employee` WHERE 1=0;');
    // No namedParams should be added for IS NOT NULL
    expect(result.namedParams?.params).toEqual({});
    expect(result.namedParams?.types).toEqual({});
  });
});
