import { QueryBuilder } from '@proteinjs/db-query';
import { ColumnQueryRuntime, Table } from '../src/Table';
import { withRecordColumns, Record } from '../src/Record';
import { StringColumn } from '../src/Columns';
import { TableQueryTransformProvider } from '../src/TableQueryTransformProvider';
import { EncryptedColumnQueryError } from '../src/encryption/EncryptedColumnQueryError';
import { EncryptedColumns } from '../src/encryption/EncryptedColumns';

interface Doc extends Record {
  title?: string; // encrypted + contains
  label?: string; // encrypted + equality
  body?: string; // encrypted, no search
  sorted?: string; // encrypted + sortKey
  status?: string; // plaintext
}

let contractTableCounter = 0;
const docTable = (): Table<Doc> =>
  new (class extends Table<Doc> {
    name = `enc_contract_test_${contractTableCounter++}`;
    columns = withRecordColumns<Doc>({
      title: new StringColumn('title', { encrypted: { searchable: 'contains' } }),
      label: new StringColumn('label', { encrypted: { searchable: 'equality' } }),
      body: new StringColumn('body', { encrypted: {} }),
      sorted: new StringColumn('sorted', { encrypted: { sortKey: { revealPrefix: 3 } } }),
      status: new StringColumn('status', { encrypted: false }),
    });
  })();

const runtime: ColumnQueryRuntime = {
  runAsSystem: false,
  query: async () => {
    throw new Error('query runner should not be reached by rejection paths');
  },
  systemQuery: async () => {
    throw new Error('systemQuery runner should not be reached by rejection paths');
  },
};

/**
 * The framework path under test: the column's own query contract
 * (`Column.queryTransform`, derived by EncryptedColumns.ensureSchema) applied through
 * db-query's `QueryBuilder.applyColumnTransforms` — exactly as `Db.addColumnQueries`
 * invokes it.
 */
const translate = (table: Table<Doc>, qb: QueryBuilder<Doc>) => {
  new EncryptedColumns().ensureSchema(table);
  return qb.applyColumnTransforms(
    new TableQueryTransformProvider((name) => {
      if (name !== table.name) {
        throw new Error(`Unable to find table: ${name}`);
      }
      return table;
    }, runtime)
  );
};

/**
 * THE COMPATIBILITY CONTRACT's rejected set — every out-of-contract shape on an encrypted
 * column throws at query-build time with an error naming the limitation and the sanctioned
 * paths ("a limitation a developer cannot hit silently is a contract").
 */
describe('Encrypted-column query contract: loud rejections', () => {
  test('DB-side ORDER BY without a declared sortKey — the spec error, naming the three options', async () => {
    const table = docTable();
    const qb = new QueryBuilder<Doc>(table.name).sort([{ field: 'title' }]);
    await expect(translate(table, qb)).rejects.toThrow(EncryptedColumnQueryError);

    const qb2 = new QueryBuilder<Doc>(table.name).sort([{ field: 'title' }]);
    await expect(translate(table, qb2)).rejects.toThrow(
      /Cannot ORDER BY encrypted column.*no sortKey declared.*sort by a metadata column.*sort the fetched rows.*revealPrefix/s
    );
  });

  test('ORDER BY with a declared sortKey translates onto the reveal-prefix companion', async () => {
    const table = docTable();
    const qb = new QueryBuilder<Doc>(table.name).sort([{ field: 'sorted', desc: true }]);
    await translate(table, qb);
    expect(qb.getSortCriteria()[0].field).toBe(new EncryptedColumns().sortCompanionProp(table, 'sorted'));
  });

  test('range conditions are rejected', async () => {
    const table = docTable();
    for (const operator of ['<', '>', '<=', '>='] as const) {
      const qb = new QueryBuilder<Doc>(table.name).condition({ field: 'title', operator, value: 'm' });
      await expect(translate(table, qb)).rejects.toThrow(/range condition/);
    }
    const between = new QueryBuilder<Doc>(table.name).condition({
      field: 'title',
      operator: 'BETWEEN',
      value: ['a', 'z'] as any,
    });
    await expect(translate(table, between)).rejects.toThrow(EncryptedColumnQueryError);
  });

  test('LIKE shapes beyond contains/prefix/suffix/exact are rejected', async () => {
    for (const pattern of ['a%b', '%a%b%', 'a_b', 'a\\%b']) {
      const table = docTable();
      const qb = new QueryBuilder<Doc>(table.name).condition({ field: 'title', operator: 'LIKE', value: pattern });
      await expect(translate(table, qb)).rejects.toThrow(/Supported: contains/);
    }
  });

  test('NOT LIKE / negated equality are rejected', async () => {
    for (const operator of ['NOT LIKE', '<>', '!=', 'NOT IN'] as const) {
      const table = docTable();
      const qb = new QueryBuilder<Doc>(table.name).condition({
        field: 'title',
        operator,
        value: operator === 'NOT IN' ? (['x'] as any) : 'x',
      });
      await expect(translate(table, qb)).rejects.toThrow(EncryptedColumnQueryError);
    }
  });

  test('aggregation over the value (MIN/MAX/SUM/AVG) is rejected; COUNT is native', async () => {
    for (const fn of ['MIN', 'MAX', 'SUM', 'AVG'] as const) {
      const table = docTable();
      const qb = new QueryBuilder<Doc>(table.name).aggregate({ function: fn, field: 'title' });
      await expect(translate(table, qb)).rejects.toThrow(/Aggregation over/);
    }

    const countTable = docTable();
    const countQb = new QueryBuilder<Doc>(countTable.name).aggregate({ function: 'COUNT', resultProp: 'count' });
    await expect(translate(countTable, countQb)).resolves.toBeUndefined();
  });

  test('GROUP BY the value is rejected', async () => {
    const table = docTable();
    const qb = new QueryBuilder<Doc>(table.name).groupBy(['title']);
    await expect(translate(table, qb)).rejects.toThrow(/GROUP BY/);
  });

  test('equality without a searchable: equality declaration is rejected, naming the declaration', async () => {
    const table = docTable();
    const qb = new QueryBuilder<Doc>(table.name).condition({ field: 'body', operator: '=', value: 'x' });
    await expect(translate(table, qb)).rejects.toThrow(/searchable: 'equality'/);
  });

  test('LIKE without a searchable: contains declaration is rejected, naming the declaration', async () => {
    const table = docTable();
    const qb = new QueryBuilder<Doc>(table.name).condition({ field: 'body', operator: 'LIKE', value: '%x%' });
    await expect(translate(table, qb)).rejects.toThrow(/searchable: 'contains'/);
  });

  test('case-insensitive equality is rejected (fingerprints cover the exact value)', async () => {
    const table = docTable();
    const qb = new QueryBuilder<Doc>(table.name);
    qb.condition({ field: 'label', operator: '=', value: 'x' }, undefined, false);
    await expect(translate(table, qb)).rejects.toThrow(/case-insensitively/);
  });

  test('subquery comparison against an encrypted column is rejected', async () => {
    const table = docTable();
    const sub = new QueryBuilder<any>('other_table').select({ fields: ['id'] });
    const qb = new QueryBuilder<Doc>(table.name).condition({ field: 'label', operator: 'IN', value: sub as any });
    await expect(translate(table, qb)).rejects.toThrow(/subquery/);
  });

  test('value-CASE ordering (byValues) on an encrypted column is rejected', async () => {
    const table = docTable();
    const qb = new QueryBuilder<Doc>(table.name).sort([{ field: 'sorted', byValues: ['a', 'b'] }]);
    await expect(translate(table, qb)).rejects.toThrow(/ORDER BY specific values/);
  });

  test('null-checks stay native: IS NULL / IS NOT NULL / = null pass through untouched', async () => {
    const table = docTable();
    const qb = new QueryBuilder<Doc>(table.name)
      .condition({ field: 'title', operator: 'IS NULL' })
      .condition({ field: 'body', operator: 'IS NOT NULL' })
      .condition({ field: 'label', operator: '=', value: null });
    await expect(translate(table, qb)).resolves.toBeUndefined();
  });

  test('everything on OTHER columns is untouched', async () => {
    const table = docTable();
    const qb = new QueryBuilder<Doc>(table.name)
      .condition({ field: 'status', operator: 'LIKE', value: '%anything%' })
      .sort([{ field: 'status' }])
      .groupBy(['status'])
      .aggregate({ function: 'MAX', field: 'status' });
    await expect(translate(table, qb)).resolves.toBeUndefined();
  });

  test('LIKE %% (match-any) rewrites to a native IS NOT NULL', async () => {
    const table = docTable();
    const qb = new QueryBuilder<Doc>(table.name).condition({ field: 'title', operator: 'LIKE', value: '%%' });
    await translate(table, qb);
    const conditionNode: any = qb.graph
      .nodes()
      .map((id: string) => qb.graph.node(id))
      .find((node: any) => node?.type === 'CONDITION');
    expect(conditionNode.operator).toBe('IS NOT NULL');
  });
});
