import moment from 'moment';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import {
  BooleanColumn,
  Db,
  IntegerColumn,
  QueryBuilderFactory,
  Record,
  StringColumn,
  Table,
  withRecordColumns,
} from '@proteinjs/db';
import { registerTestUser, clearTestUser } from '@proteinjs/db/test';
import { TransactionContext } from '@proteinjs/db-transaction-context';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * `Db.queryAggregates` against real Spanner semantics: grouped SUM/COUNT rows come back with
 * the group fields + aggregate resultProps, and `timeBucket('day')` truncates in UTC — two rows
 * 60 minutes apart across a UTC midnight land in DIFFERENT buckets (a local-TZ truncation, e.g.
 * America/Los_Angeles, would merge them: both fall on the same LA calendar day).
 */

interface UsageShape extends Record {
  model: string;
  source: string;
  totalTokens: number;
  costMicroUsd: number;
  priced: boolean;
}

class UsageShapeTable extends Table<UsageShape> {
  name = 'db_test_query_aggregates';
  columns = withRecordColumns<UsageShape>({
    model: new StringColumn('model'),
    source: new StringColumn('source'),
    totalTokens: new IntegerColumn('total_tokens', undefined, true),
    costMicroUsd: new IntegerColumn('cost_micro_usd', undefined, true),
    priced: new BooleanColumn('priced'),
  });
}

const table = new UsageShapeTable();
const getTable = (tableName: string) => {
  if (tableName === table.name) {
    return table;
  }
  throw new Error(`Unexpected table lookup in test: ${tableName}`);
};

const spannerDriver = new SpannerDriver(
  {
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  },
  getTable
);

const seedRow = (over: Partial<UsageShape>) => ({
  model: 'model-a',
  source: 'chat_turn',
  totalTokens: 0,
  costMicroUsd: 0,
  priced: true,
  ...over,
});

/** Bucket values arrive as the driver returns them (Date/ISO string); normalize to YYYY-MM-DD. */
const dayOf = (value: unknown): string => new Date(String(value)).toISOString().slice(0, 10);

describe('Db.queryAggregates (grouped aggregation + UTC day buckets)', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const db = new Db(spannerDriver, getTable, new TransactionContext());

  beforeAll(async () => {
    // The table declares no auth block → the default admin door; carry that identity.
    registerTestUser();
    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    await dropTable(table);
    await spannerDriver.getTableManager().loadTable(table);

    // Two models, two sources, three UTC instants — the last two straddle a UTC midnight.
    await db.insert(
      table,
      seedRow({
        model: 'model-a',
        source: 'chat_turn',
        totalTokens: 1000,
        costMicroUsd: 50_000,
        created: moment.utc('2026-08-10T10:00:00Z'),
      }) as any
    );
    await db.insert(
      table,
      seedRow({
        model: 'model-a',
        source: 'flow_request',
        totalTokens: 200,
        costMicroUsd: 10_000,
        created: moment.utc('2026-08-10T23:30:00Z'),
      }) as any
    );
    await db.insert(
      table,
      seedRow({
        model: 'model-b',
        source: 'chat_turn',
        totalTokens: 40,
        costMicroUsd: 2_000,
        priced: false,
        created: moment.utc('2026-08-11T00:30:00Z'),
      }) as any
    );
  }, 60000);

  afterAll(async () => {
    clearTestUser();
    await dropTable(table);
    await SpannerEmulatorProvisioner.release();
  }, 30000);

  test('grouped SUM/COUNT rows carry group fields + aggregate resultProps', async () => {
    const qb = new QueryBuilderFactory()
      .createQueryBuilder<UsageShape>(table)
      .select({ fields: ['model'] })
      .groupBy(['model'])
      .aggregate({ function: 'SUM', field: 'totalTokens', resultProp: 'totalTokens' })
      .aggregate({ function: 'SUM', field: 'costMicroUsd', resultProp: 'costMicroUsd' })
      .aggregate({ function: 'COUNT', resultProp: 'requests' });
    const rows = await db.queryAggregates(table, qb);

    const byModel = new Map(rows.map((row) => [row.model, row]));
    expect(byModel.size).toBe(2);
    expect(Number(byModel.get('model-a')!.totalTokens)).toBe(1200);
    expect(Number(byModel.get('model-a')!.costMicroUsd)).toBe(60_000);
    expect(Number(byModel.get('model-a')!.requests)).toBe(2);
    expect(Number(byModel.get('model-b')!.totalTokens)).toBe(40);
    expect(Number(byModel.get('model-b')!.requests)).toBe(1);
  }, 60000);

  test('timeBucket buckets by UTC day — rows across a UTC midnight land apart', async () => {
    const qb = new QueryBuilderFactory()
      .createQueryBuilder<UsageShape>(table)
      .timeBucket({ field: 'created', unit: 'day', resultProp: 'day' })
      .aggregate({ function: 'SUM', field: 'totalTokens', resultProp: 'totalTokens' });
    const rows = await db.queryAggregates(table, qb);

    const byDay = new Map(rows.map((row) => [dayOf(row.day), Number(row.totalTokens)]));
    expect(byDay.size).toBe(2);
    expect(byDay.get('2026-08-10')).toBe(1200); // 10:00Z + 23:30Z
    expect(byDay.get('2026-08-11')).toBe(40); // 00:30Z — next UTC day
  }, 60000);

  test('group fields, day bucket, aggregates, and conditions compose in one statement', async () => {
    const qb = new QueryBuilderFactory()
      .createQueryBuilder<UsageShape>(table)
      .condition({ field: 'priced', operator: '=', value: true })
      .select({ fields: ['model', 'source'] })
      .groupBy(['model', 'source'])
      .timeBucket({ field: 'created', unit: 'day', resultProp: 'day' })
      .aggregate({ function: 'SUM', field: 'totalTokens', resultProp: 'totalTokens' })
      .aggregate({ function: 'COUNT', resultProp: 'requests' });
    const rows = await db.queryAggregates(table, qb);

    // priced=false row excluded; model-a splits by source, same day for the 10:00Z/23:30Z rows.
    expect(rows).toHaveLength(2);
    const key = (row: { [k: string]: unknown }) => `${row.model}/${row.source}/${dayOf(row.day)}`;
    const byKey = new Map(rows.map((row) => [key(row), row]));
    expect(Number(byKey.get('model-a/chat_turn/2026-08-10')!.totalTokens)).toBe(1000);
    expect(Number(byKey.get('model-a/flow_request/2026-08-10')!.totalTokens)).toBe(200);
    expect(Number(byKey.get('model-a/chat_turn/2026-08-10')!.requests)).toBe(1);
  }, 60000);

  // LAST test: it seeds an extra same-hour row; afterAll drops the table so no cleanup needed.
  test('timeBucket(hour) buckets by UTC hour — cross-hour rows split, same-hour rows merge (V2.3)', async () => {
    const hourQb = () =>
      new QueryBuilderFactory()
        .createQueryBuilder<UsageShape>(table)
        .timeBucket({ field: 'created', unit: 'hour', resultProp: 'hour' })
        .aggregate({ function: 'SUM', field: 'totalTokens', resultProp: 'totalTokens' })
        .aggregate({ function: 'COUNT', resultProp: 'requests' });

    // Seeded UTC instants: 10:00Z (1000), 23:30Z (200), next-day 00:30Z (40) — three DISTINCT
    // UTC hours. Under DAY grain the first two merged (both 2026-08-10); under HOUR they split.
    const byHour = new Map(
      (await db.queryAggregates(table, hourQb())).map((row) => [
        new Date(String(row.hour)).toISOString(),
        Number(row.totalTokens),
      ])
    );
    expect(byHour.size).toBe(3);
    expect(byHour.get('2026-08-10T10:00:00.000Z')).toBe(1000);
    expect(byHour.get('2026-08-10T23:00:00.000Z')).toBe(200); // 23:30Z floors to 23:00Z
    expect(byHour.get('2026-08-11T00:00:00.000Z')).toBe(40); // 00:30Z → its own hour, not merged with 23:30Z

    // A second row INSIDE an existing hour must MERGE, not open a new bucket (30 min apart, same hour).
    await db.insert(
      table,
      seedRow({ model: 'model-c', totalTokens: 7, created: moment.utc('2026-08-10T10:45:00Z') }) as any
    );
    const byHour2 = new Map(
      (await db.queryAggregates(table, hourQb())).map((row) => [new Date(String(row.hour)).toISOString(), row])
    );
    expect(byHour2.size).toBe(3); // still three hours — 10:00Z absorbed the 10:45Z row
    expect(Number(byHour2.get('2026-08-10T10:00:00.000Z')!.totalTokens)).toBe(1007); // 1000 + 7
    expect(Number(byHour2.get('2026-08-10T10:00:00.000Z')!.requests)).toBe(2);
  }, 60000);
});
