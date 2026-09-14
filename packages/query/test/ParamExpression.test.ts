import '../generated/index';
import { QueryBuilder } from '../src/QueryBuilder';
import { ParamType, StatementConfig, StatementFactory, StatementParamManager } from '../src/StatementFactory';

/**
 * `StatementConfig.paramExpression` — the dialect hook through which a driver stands a SQL
 * expression in for a bound param's placeholder, keyed on the param's driver type (a driver
 * whose JSON type refuses raw JSON params binds them as `PARSE_JSON(@p, …)` over a STRING
 * param). The hook shapes the SQL only: the param's value and declared type reach the driver
 * unchanged, for its own wire step to convert.
 */
describe('StatementConfig.paramExpression', () => {
  interface Doc {
    id: string;
    payload: object;
    tag: string;
  }

  const tableName = 'Doc';
  const driverColumnType = (_table: string, column: string) => (column === 'payload' ? 'json' : 'string');
  const hooked: StatementConfig = {
    useParams: true,
    useNamedParams: true,
    getDriverColumnType: driverColumnType,
    paramExpression: (placeholder, type) => (type === 'json' ? `PARSE_JSON(${placeholder})` : placeholder),
  };
  const payload = { cost: 0.915908 };

  test('insert: the hooked type binds through its expression; value and type reach the driver unchanged', () => {
    const result = new StatementFactory<Doc>().insert(tableName, { id: 'd1', payload }, hooked);
    expect(result.sql).toBe('INSERT INTO `Doc` (`id`, `payload`) VALUES (@param0, PARSE_JSON(@param1));');
    expect(result.namedParams).toEqual({
      params: { param0: 'd1', param1: payload },
      types: { param0: 'string', param1: 'json' },
    });
  });

  test('update: SET clauses bind through the expression; other params keep their bare placeholder', () => {
    const qb = new QueryBuilder<Doc>(tableName).condition({ field: 'id', operator: '=', value: 'd1' });
    const result = new StatementFactory<Doc>().update(tableName, { payload }, qb, hooked);
    expect(result.sql).toBe('UPDATE `Doc` SET `payload` = PARSE_JSON(@param0) WHERE `id` = @param1;');
    expect(result.namedParams?.types).toEqual({ param0: 'json', param1: 'string' });
  });

  test('subquery: the namespaced param rename rewrites the placeholder inside the expression', () => {
    const inner = new QueryBuilder<Doc>(tableName).condition({ field: 'payload', operator: '=', value: payload });
    const outer = new QueryBuilder<Doc>(tableName).condition({ field: 'id', operator: 'IN', value: inner });
    const result = outer.toSql(hooked);
    expect(result.sql).toContain('`payload` = PARSE_JSON(@sq0_param0)');
    expect(result.sql).not.toContain('@param0');
    expect(result.namedParams?.params.sq0_param0).toEqual(payload);
    expect(result.namedParams?.types.sq0_param0).toBe('json');
  });

  test('an array value hands the hook the array type descriptor', () => {
    const seen: ParamType[] = [];
    const manager = new StatementParamManager({
      ...hooked,
      paramExpression: (placeholder, type) => {
        seen.push(type);
        return placeholder;
      },
    });
    expect(manager.parameterize(['a', 'b'], 'string')).toBe('@param0');
    expect(seen).toEqual([{ type: 'array', child: { type: 'string' } }]);
  });

  test('without the hook every param binds as its bare placeholder (control)', () => {
    const result = new StatementFactory<Doc>().insert(
      tableName,
      { id: 'd1', payload },
      { ...hooked, paramExpression: undefined }
    );
    expect(result.sql).toBe('INSERT INTO `Doc` (`id`, `payload`) VALUES (@param0, @param1);');
  });
});
