import '../generated/index';
import { Serializer } from '@proteinjs/serializer';
import { QueryBuilder } from '../src/QueryBuilder';

describe('QueryBuilder - Serialization', () => {
  interface Employee {
    id: number;
    department: string;
    salary: number;
    yearsOfExperience: number;
  }

  const dbName = 'test';
  const tableName = 'Employee';

  test('should serialize/deserialize a triple-nested subquery: query -> subquery -> sub-subquery', () => {
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

    const qbClone = Serializer.deserialize(Serializer.serialize(qb));

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
