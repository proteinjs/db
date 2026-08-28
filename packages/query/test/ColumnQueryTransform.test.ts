import { QueryBuilder } from '../src/QueryBuilder';
import { ColumnQueryTransform, ColumnQueryTransformProvider } from '../src/ColumnQueryTransform';
import { StatementConfig } from '../src/StatementFactory';

interface Doc {
  id: string;
  secret?: string;
  status?: string;
}

const config: StatementConfig = { useParams: false };

const providerFor = (transforms: { [prop: string]: ColumnQueryTransform<Doc> }): ColumnQueryTransformProvider => ({
  getTransform: (tableName, prop) => (tableName === 'doc' ? transforms[prop] : undefined),
});

/**
 * The generic column query-transform seam: `QueryBuilder.applyColumnTransforms` consults
 * each column's `ColumnQueryTransform` for every use of the column (conditions — including
 * subquery values, sorts, aggregations, GROUP BY) and splices replacements into its own
 * graph. Encryption in @proteinjs/db is one consumer; the seam itself is column-model
 * agnostic — these tests use a plain artifact-column transform.
 */
describe('QueryBuilder.applyColumnTransforms', () => {
  test('condition replacement: a condition rewrites onto a derived artifact column', async () => {
    const qb = new QueryBuilder<Doc>('doc').condition({ field: 'secret', operator: '=', value: 'v' });
    await qb.applyColumnTransforms(
      providerFor({
        secret: {
          transformCondition: async (condition) => ({
            field: 'secret_artifact' as any,
            operator: 'IN',
            value: [`fp(${condition.value})`] as any,
          }),
        },
      })
    );
    const { sql } = qb.toSql(config);
    expect(sql).toContain('`secret_artifact` IN');
    expect(sql).not.toContain("'v'");
  });

  test('condition replacement: a logical-group replacement splices into the graph', async () => {
    const qb = new QueryBuilder<Doc>('doc')
      .condition({ field: 'secret', operator: '=', value: 'v' })
      .condition({ field: 'status', operator: '=', value: 'open' });
    await qb.applyColumnTransforms(
      providerFor({
        secret: {
          transformCondition: async () => ({
            operator: 'OR',
            children: [
              { field: 'secret_artifact' as any, operator: '=', value: 'fpA' as any },
              { field: 'secret_artifact' as any, operator: '=', value: 'fpB' as any },
            ],
          }),
        },
      })
    );
    const { sql } = qb.toSql(config);
    expect(sql).toMatch(/\(`secret_artifact` = 'fpA' OR `secret_artifact` = 'fpB'\)/);
    expect(sql).toContain("`status` = 'open'"); // untouched sibling, still ANDed
  });

  test('replacement conditions are normalized: an empty IN renders the empty-set condition', async () => {
    const qb = new QueryBuilder<Doc>('doc').condition({ field: 'secret', operator: 'LIKE', value: '%v%' });
    await qb.applyColumnTransforms(
      providerFor({
        secret: {
          transformCondition: async () => ({ field: 'id', operator: 'IN', value: [] as any }),
        },
      })
    );
    expect(qb.toSql(config).sql).toContain('1=0');
  });

  test('a transform may throw its contract error at query-build time', async () => {
    const qb = new QueryBuilder<Doc>('doc').condition({ field: 'secret', operator: '>', value: 'm' });
    await expect(
      qb.applyColumnTransforms(
        providerFor({
          secret: {
            transformCondition: async (condition) => {
              if (condition.operator === '>') {
                throw new Error('ranges are outside this column contract');
              }
              return undefined;
            },
          },
        })
      )
    ).rejects.toThrow('outside this column contract');
  });

  test('subquery condition values are transformed recursively', async () => {
    const sub = new QueryBuilder<Doc>('doc').select({ fields: ['id'] }).condition({
      field: 'secret',
      operator: '=',
      value: 'v',
    });
    const qb = new QueryBuilder<Doc>('doc').condition({ field: 'id', operator: 'IN', value: sub });
    await qb.applyColumnTransforms(
      providerFor({
        secret: {
          transformCondition: async () => ({ field: 'secret_artifact' as any, operator: '=', value: 'fp' as any }),
        },
      })
    );
    expect(qb.toSql(config).sql).toContain("`secret_artifact` = 'fp'");
  });

  test('sort, aggregate, and group-by uses consult the transform', async () => {
    const qb = new QueryBuilder<Doc>('doc')
      .sort([{ field: 'secret' }])
      .groupBy(['secret'])
      .aggregate({ function: 'COUNT', field: 'secret', resultProp: 'n' });
    await qb.applyColumnTransforms(
      providerFor({
        secret: {
          transformSort: (criteria) => ({ ...criteria, field: 'secret_sort' as any }),
          transformGroupByField: () => 'secret_artifact',
          transformAggregate: (aggregate) => ({ ...aggregate, field: 'secret_artifact' as any }),
        },
      })
    );
    const { sql } = qb.toSql(config);
    expect(sql).toContain('ORDER BY `secret_sort`');
    expect(sql).toContain('GROUP BY `secret_artifact`');
    expect(sql).toContain('COUNT(`secret_artifact`) as n');
  });

  test('a sort transform may reject (the declared-capability shape)', async () => {
    const qb = new QueryBuilder<Doc>('doc').sort([{ field: 'secret' }]);
    await expect(
      qb.applyColumnTransforms(
        providerFor({
          secret: {
            transformSort: () => {
              throw new Error('cannot ORDER BY this column');
            },
          },
        })
      )
    ).rejects.toThrow('cannot ORDER BY');
  });

  test('applies exactly once per builder; untouched columns and absent transforms pass through', async () => {
    let calls = 0;
    const qb = new QueryBuilder<Doc>('doc')
      .condition({ field: 'secret', operator: '=', value: 'v' })
      .condition({ field: 'status', operator: '=', value: 'open' });
    const provider = providerFor({
      secret: {
        transformCondition: async () => {
          calls++;
          return { field: 'secret_artifact' as any, operator: '=', value: 'fp' as any };
        },
      },
    });
    await qb.applyColumnTransforms(provider);
    await qb.applyColumnTransforms(provider);
    expect(calls).toBe(1);
    expect(qb.toSql(config).sql).toContain("`status` = 'open'");
  });

  test('a transform returning undefined leaves the use untouched', async () => {
    const qb = new QueryBuilder<Doc>('doc').condition({ field: 'secret', operator: 'IS NULL' });
    await qb.applyColumnTransforms(providerFor({ secret: { transformCondition: async () => undefined } }));
    expect(qb.toSql(config).sql).toContain('`secret` IS NULL');
  });
});
