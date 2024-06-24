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
      'SELECT * FROM `test`.`Employee` WHERE `id` IN (SELECT * FROM `test`.`Employee` WHERE `department` = @param0);'
    );
    expect(result.namedParams?.params).toEqual({ param0: 'Engineering' });
    expect(result.namedParams?.types).toEqual({ param0: 'string' });
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
      param3: 'HR',
      param4: 5,
      param5: 60000,
      param6: 'IT',
      param7: 80000,
    };
    expect(result.sql).toContain(
      'SELECT * FROM `test`.`Employee` WHERE (`department` = @param0 OR (`salary` > @param1 AND (`yearsOfExperience` <= @param2 OR `id` IN (SELECT * FROM `test`.`Employee` WHERE (`department` = @param0 AND `yearsOfExperience` > @param1 AND `salary` < @param2) AND (`department` = @param3 OR `salary` >= @param4)))));'
    );
    expect(result.namedParams?.params).toEqual(expectedParams);
    expect(result.namedParams?.types).toEqual({
      param0: 'string',
      param1: 'number',
      param2: 'number',
      param3: 'string',
      param4: 'number',
      param5: 'number',
      param6: 'string',
      param7: 'number',
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
