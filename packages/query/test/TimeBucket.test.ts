import { QueryBuilder } from '../src/QueryBuilder';

/**
 * Grouped-aggregation statement shapes for reporting reads (Db.queryAggregates):
 * select fields + aggregates COMPOSE in one select list, and `timeBucket` adds a
 * driver-truncated datetime dimension that is both selected (aliased) and grouped on.
 */
describe('QueryBuilder - grouped aggregation select list + time buckets', () => {
  interface UsageRow {
    id: string;
    model: string;
    source: string;
    totalTokens: number;
    costMicroUsd: number;
    created: Date;
  }

  const tableName = 'usage_event';
  const dbName = 'test';
  // A driver-style day-truncation expression (the Spanner shape).
  const dateTruncExpression = (col: string, _unit: 'day') => `TIMESTAMP_TRUNC(${col}, DAY, 'UTC')`;

  test('select fields and aggregates compose in one select list', () => {
    const qb = new QueryBuilder<UsageRow>(tableName)
      .select({ fields: ['model', 'source'] })
      .groupBy(['model', 'source'])
      .aggregate({ function: 'SUM', field: 'totalTokens', resultProp: 'totalTokens' })
      .aggregate({ function: 'COUNT', resultProp: 'requests' });

    const result = qb.toSql({ dbName });
    expect(result.sql).toBe(
      'SELECT `model`, `source`, SUM(`totalTokens`) as totalTokens, COUNT(*) as requests ' +
        'FROM `test`.`usage_event` GROUP BY `model`, `source`;'
    );
  });

  test('timeBucket selects the truncation expression under its alias and groups on the expression', () => {
    const qb = new QueryBuilder<UsageRow>(tableName)
      .select({ fields: ['model'] })
      .groupBy(['model'])
      .timeBucket({ field: 'created', unit: 'day', resultProp: 'day' })
      .aggregate({ function: 'SUM', field: 'costMicroUsd', resultProp: 'costMicroUsd' });

    const result = qb.toSql({ dbName, dateTruncExpression });
    expect(result.sql).toBe(
      "SELECT `model`, TIMESTAMP_TRUNC(`created`, DAY, 'UTC') as day, SUM(`costMicroUsd`) as costMicroUsd " +
        "FROM `test`.`usage_event` GROUP BY `model`, TIMESTAMP_TRUNC(`created`, DAY, 'UTC');"
    );
  });

  test('timeBucket composes with conditions (WHERE precedes GROUP BY, params intact)', () => {
    const qb = new QueryBuilder<UsageRow>(tableName)
      .condition({ field: 'source', operator: '=', value: 'chat_turn' })
      .timeBucket({ field: 'created', unit: 'day', resultProp: 'day' })
      .aggregate({ function: 'SUM', field: 'totalTokens', resultProp: 'totalTokens' });

    const result = qb.toSql({ dbName, useParams: true, dateTruncExpression });
    expect(result.sql).toBe(
      "SELECT TIMESTAMP_TRUNC(`created`, DAY, 'UTC') as day, SUM(`totalTokens`) as totalTokens " +
        "FROM `test`.`usage_event` WHERE `source` = ? GROUP BY TIMESTAMP_TRUNC(`created`, DAY, 'UTC');"
    );
    expect(result.params).toEqual(['chat_turn']);
  });

  test('timeBucket without driver support fails loudly at statement generation', () => {
    const qb = new QueryBuilder<UsageRow>(tableName)
      .timeBucket({ field: 'created', unit: 'day', resultProp: 'day' })
      .aggregate({ function: 'COUNT', resultProp: 'requests' });

    expect(() => qb.toSql({ dbName })).toThrow(/no dateTruncExpression/);
  });

  test('aggregates-only and fields-only select lists are unchanged (pinned pre-existing shapes)', () => {
    const aggOnly = new QueryBuilder<UsageRow>(tableName)
      .aggregate({ function: 'SUM', field: 'totalTokens', resultProp: 'totalTokens' })
      .toSql({ dbName });
    expect(aggOnly.sql).toBe('SELECT SUM(`totalTokens`) as totalTokens FROM `test`.`usage_event`;');

    const fieldsOnly = new QueryBuilder<UsageRow>(tableName).select({ fields: ['model'] }).toSql({ dbName });
    expect(fieldsOnly.sql).toBe('SELECT `model` FROM `test`.`usage_event`;');
  });
});
