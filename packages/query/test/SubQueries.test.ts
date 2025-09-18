import { QueryBuilder } from '../src/QueryBuilder';

describe('QueryBuilder - Sub Query Support', () => {
  interface Employee {
    id: number;
    department: string;
    salary: number;
    yearsOfExperience: number;
  }

  const dbName = 'test';
  const tableName = 'Employee';

  // Subquery as a condition
  test('Subquery as a condition using IN operator', () => {
    const subQb = new QueryBuilder<Employee>(tableName).condition({
      field: 'department',
      operator: '=',
      value: 'Engineering',
    });
    const qb = new QueryBuilder<Employee>(tableName).condition({
      field: 'id',
      operator: 'IN',
      value: subQb,
    });

    // Standard SQL output for subquery
    let result = qb.toSql({ dbName });
    expect(result.sql).toBe(
      "SELECT * FROM `test`.`Employee` WHERE `id` IN (SELECT * FROM `test`.`Employee` WHERE `department` = 'Engineering');"
    );

    // SQL output with positional parameters for subquery
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toContain(
      'SELECT * FROM `test`.`Employee` WHERE `id` IN (SELECT * FROM `test`.`Employee` WHERE `department` = ?);'
    );
    expect(result.params).toEqual(['Engineering']);

    // SQL output with named parameters and types for subquery
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
    expect(result.sql).toContain(
      'SELECT * FROM `test`.`Employee` WHERE `id` IN (SELECT * FROM `test`.`Employee` WHERE `department` = @sq0_param0);'
    );
    expect(result.namedParams?.params).toEqual({ sq0_param0: 'Engineering' });
    expect(result.namedParams?.types).toEqual({ sq0_param0: 'string' });
  });

  test('Complex query with deeply nested, complex subquery', () => {
    // Complex subquery without subqueries, using logical operators
    const complexSubQuery = new QueryBuilder<Employee>(tableName)
      .and([
        { field: 'department', operator: '=', value: 'HR' },
        { field: 'yearsOfExperience', operator: '>', value: 5 },
        { field: 'salary', operator: '<', value: 60000 },
      ])
      .or([
        { field: 'department', operator: '=', value: 'IT' },
        { field: 'salary', operator: '>=', value: 80000 },
      ]);

    // Main query with nested logical groups, incorporating the complexSubQuery
    const mainQuery = new QueryBuilder<Employee>(tableName).or([
      { field: 'department', operator: '=', value: 'Engineering' },
      {
        operator: 'AND',
        children: [
          { field: 'salary', operator: '>', value: 50000 },
          {
            operator: 'OR',
            children: [
              { field: 'yearsOfExperience', operator: '<=', value: 3 },
              { field: 'id', operator: 'IN', value: complexSubQuery },
            ],
          },
        ],
      },
    ]);

    // Standard SQL output for the main query
    let result = mainQuery.toSql({ dbName });
    const expectedSql =
      "SELECT * FROM `test`.`Employee` WHERE (`department` = 'Engineering' OR (`salary` > 50000 AND (`yearsOfExperience` <= 3 OR `id` IN (SELECT * FROM `test`.`Employee` WHERE (`department` = 'HR' AND `yearsOfExperience` > 5 AND `salary` < 60000) AND (`department` = 'IT' OR `salary` >= 80000)))));";
    expect(result.sql).toBe(expectedSql);

    // SQL output with positional parameters
    result = mainQuery.toSql({ dbName, useParams: true });
    expect(result.sql).toContain(
      'SELECT * FROM `test`.`Employee` WHERE (`department` = ? OR (`salary` > ? AND (`yearsOfExperience` <= ? OR `id` IN (SELECT * FROM `test`.`Employee` WHERE (`department` = ? AND `yearsOfExperience` > ? AND `salary` < ?) AND (`department` = ? OR `salary` >= ?)))));'
    );
    expect(result.params).toEqual(['Engineering', 50000, 3, 'HR', 5, 60000, 'IT', 80000]);

    // SQL output with named parameters and types
    result = mainQuery.toSql({ dbName, useParams: true, useNamedParams: true });
    const expectedParams = {
      param0: 'Engineering',
      param1: 50000,
      param2: 3,
      sq0_param0: 'HR',
      sq0_param1: 5,
      sq0_param2: 60000,
      sq0_param3: 'IT',
      sq0_param4: 80000,
    };
    expect(result.sql).toContain(
      'SELECT * FROM `test`.`Employee` WHERE (`department` = @param0 OR (`salary` > @param1 AND (`yearsOfExperience` <= @param2 OR `id` IN (SELECT * FROM `test`.`Employee` WHERE (`department` = @sq0_param0 AND `yearsOfExperience` > @sq0_param1 AND `salary` < @sq0_param2) AND (`department` = @sq0_param3 OR `salary` >= @sq0_param4)))));'
    );
    expect(result.namedParams?.params).toEqual(expectedParams);
    expect(result.namedParams?.types).toEqual({
      param0: 'string',
      param1: 'number',
      param2: 'number',
      sq0_param0: 'string',
      sq0_param1: 'number',
      sq0_param2: 'number',
      sq0_param3: 'string',
      sq0_param4: 'number',
    });
  });

  test('Triple-nested subquery: query -> subquery -> sub-subquery', () => {
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

    // Standard SQL
    let result = qb.toSql({ dbName });
    const expectedSql =
      "SELECT * FROM `test`.`Employee` WHERE (`department` = 'Engineering' AND `id` IN (SELECT * FROM `test`.`Employee` WHERE (`yearsOfExperience` >= 2 AND `id` IN (SELECT * FROM `test`.`Employee` WHERE (`department` = 'Support' AND `salary` > 70000)))));";
    expect(result.sql).toBe(expectedSql);

    // Positional params
    result = qb.toSql({ dbName, useParams: true });
    expect(result.sql).toContain(
      'SELECT * FROM `test`.`Employee` WHERE (`department` = ? AND `id` IN (SELECT * FROM `test`.`Employee` WHERE (`yearsOfExperience` >= ? AND `id` IN (SELECT * FROM `test`.`Employee` WHERE (`department` = ? AND `salary` > ?)))));'
    );
    expect(result.params).toEqual(['Engineering', 2, 'Support', 70000]);

    // Named params with types — align to your nested prefixing scheme (sq0 for middle, sq0_sq0 for inner)
    result = qb.toSql({ dbName, useParams: true, useNamedParams: true });
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

  test('Throws error when using same QueryBuilder instance for subquery', () => {
    const qb = new QueryBuilder<Employee>(tableName);
    const invalidCondition: any = {
      field: 'id',
      operator: 'IN',
      value: qb, // Intentionally passing the same QueryBuilder instance
    };
    const action = () => qb.condition(invalidCondition);
    expect(action).toThrowError(new Error('Must use a new QueryBuilder instance for subquery'));
  });
});
