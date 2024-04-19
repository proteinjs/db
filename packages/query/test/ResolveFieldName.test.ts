import { QueryBuilder } from '../src/QueryBuilder';

describe('QueryBuilder - Resolve Field Name Support', () => {
  interface Employee {
    id: number;
    employeeName: string;
    employeeAge: number;
    employeeSalary: number;
    department: string;
  }

  const dbName = 'test';
  const tableName = 'Employee';

  test('convert camelCase field names to snake_case', () => {
    // Define a function to resolve field names from camelCase to snake_case
    const resolveFieldName = (tableName: string, propertyName: string): string => {
      return propertyName.replace(/\.?([A-Z]+)/g, (x, y) => `_${y.toLowerCase()}`).replace(/^_/, "");
    };
    const qb = new QueryBuilder<Employee>(tableName)
      .aggregate({ function: 'MAX', field: 'employeeAge' })
      .and([
        {
          operator: 'OR',
          children: [
            {
              operator: 'AND',
              children: [
                { field: 'department', operator: '=', value: 'Engineering' },
                { field: 'employeeName', operator: 'LIKE', value: '%John%' }
              ]
            },
            { field: 'department', operator: '=', value: 'Product' }
          ]
        },
        {
          operator: 'AND',
          children: [
            { field: 'employeeAge', operator: '>', value: 30 },
            { field: 'employeeAge', operator: '<', value: 50 }
          ]
        },
        {
          operator: 'OR',
          children: [
            { field: 'employeeSalary', operator: '>', value: 50000 },
            { field: 'employeeSalary', operator: '<=', value: 100000 }
          ]
        }
      ])
      .groupBy(['employeeAge']);
  
    // Standard SQL output
    expect(qb.toSql({ dbName, resolveFieldName }).sql).toBe("SELECT MAX(employee_age) FROM test.Employee WHERE (((department = 'Engineering' AND employee_name LIKE '%John%') OR department = 'Product') AND (employee_age > 30 AND employee_age < 50) AND (employee_salary > 50000 OR employee_salary <= 100000)) GROUP BY employee_age;");
  
    // SQL output with positional parameters
    let result = qb.toSql({ dbName, resolveFieldName, useParams: true });
    expect(result.sql).toBe("SELECT MAX(employee_age) FROM test.Employee WHERE (((department = ? AND employee_name LIKE ?) OR department = ?) AND (employee_age > ? AND employee_age < ?) AND (employee_salary > ? OR employee_salary <= ?)) GROUP BY employee_age;");
    expect(result.params).toEqual(['Engineering', '%John%', 'Product', 30, 50, 50000, 100000]);
  
    // SQL output with named parameters and types
    result = qb.toSql({ dbName, resolveFieldName, useParams: true, useNamedParams: true });
    expect(result.sql).toBe("SELECT MAX(employee_age) FROM test.Employee WHERE (((department = @param0 AND employee_name LIKE @param1) OR department = @param2) AND (employee_age > @param3 AND employee_age < @param4) AND (employee_salary > @param5 OR employee_salary <= @param6)) GROUP BY employee_age;");
    expect(result.namedParams?.params).toEqual({ param0: 'Engineering', param1: '%John%', param2: 'Product', param3: 30, param4: 50, param5: 50000, param6: 100000 });
    expect(result.namedParams?.types).toEqual({ param0: 'string', param1: 'string', param2: 'string', param3: 'number', param4: 'number', param5: 'number', param6: 'number' });
  });  
});
