import { Transaction } from '@google-cloud/spanner';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { Record, StatementFactory, Table, tableByName, withRecordColumns } from '@proteinjs/db';
import { JsonColumn } from '@proteinjs/db-spanner-common';
import { QueryBuilder } from '@proteinjs/db-query';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * JSON column binding through the driver's normal statement path.
 *
 * Spanner parses a JSON-typed param in its default `exact` mode and refuses any number whose text
 * does not survive its own float64 canonicalization — ordinary shortest-form doubles among them
 * (`0.915908`, `297.3344693281405`; their 17-digit forms are refused too), so a JSON column write
 * carrying such a value fails with OUT_OF_RANGE "Input number: 0.915908 cannot round-trip through
 * string representation" and the row is lost. The driver therefore binds a JSON column as a STRING
 * param parsed by `PARSE_JSON(@p, wide_number_mode=>'round')`, the vendor's documented remedy.
 *
 * The emulator enforces the rule on JSON literals and on PARSE_JSON but NOT on JSON-typed params,
 * so the real-Spanner rule is applied here by hand: every JSON-typed param the client would send
 * is re-parsed through the emulator's exact-mode PARSE_JSON, which refuses exactly what Spanner
 * refuses.
 */

interface JsonParamsRecord extends Record {
  payload: any;
}

class JsonParamsTable extends Table<JsonParamsRecord> {
  name = 'db_test_json_params';
  columns = withRecordColumns<JsonParamsRecord>({
    payload: new JsonColumn('payload'),
  });
}

const jsonParamsTable = new JsonParamsTable();

const spannerDriver = new SpannerDriver(
  {
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  },
  (name) => (name === jsonParamsTable.name ? jsonParamsTable : tableByName(name))
);

/** Per-run unique row ids — fixtures never collide across runs or with leftover rows. */
const uniqueId = () => `json-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

type WireStatement = { sql: string; params?: { [param: string]: any }; types?: { [param: string]: any } };

/** The statements the client received for the DML the callback ran — what Spanner itself parses. */
const wireStatementsOf = async (dml: () => Promise<unknown>): Promise<WireStatement[]> => {
  const spy = jest.spyOn(Transaction.prototype, 'batchUpdate');
  try {
    await dml();
    const statements: WireStatement[] = [];
    for (const call of spy.mock.calls) {
      statements.push(...(call[0] as WireStatement[]));
    }
    return statements;
  } finally {
    spy.mockRestore();
  }
};

/**
 * Real Spanner's rule, applied to a wire statement: a JSON-typed param is the client's
 * `JSON.stringify` of the value, parsed by Spanner in exact mode — PARSE_JSON's default, which the
 * emulator enforces identically. Throws the OUT_OF_RANGE Spanner would raise for the DML.
 */
const assertSpannerExactModeAccepts = async (statements: WireStatement[]): Promise<void> => {
  for (const statement of statements) {
    for (const [name, type] of Object.entries(statement.types ?? {})) {
      if (type !== 'json') {
        continue;
      }
      const text = JSON.stringify(statement.params?.[name]);
      await spannerDriver.runQuery(() => ({
        sql: 'SELECT PARSE_JSON(@text) AS parsed',
        namedParams: { params: { text }, types: { text: 'string' } },
      }));
    }
  }
};

/** The production insert shape (Db.insert): StatementFactory against the driver's own config. */
const insertRow = async (payload: any): Promise<string> => {
  const id = uniqueId();
  await spannerDriver.runDml((config) =>
    new StatementFactory<JsonParamsRecord>().insert(
      jsonParamsTable.name,
      { id, payload } as Partial<JsonParamsRecord>,
      config
    )
  );
  return id;
};

const updateRow = async (id: string, payload: any): Promise<number> => {
  const qb = new QueryBuilder<JsonParamsRecord>(jsonParamsTable.name).condition({
    field: 'id',
    operator: '=',
    value: id,
  });
  return await spannerDriver.runDml((config) =>
    new StatementFactory<JsonParamsRecord>().update(
      jsonParamsTable.name,
      { payload } as Partial<JsonParamsRecord>,
      qb,
      config
    )
  );
};

const selectRow = async (id: string): Promise<JsonParamsRecord | undefined> => {
  const qb = new QueryBuilder<JsonParamsRecord>(jsonParamsTable.name).condition({
    field: 'id',
    operator: '=',
    value: id,
  });
  const rows = await spannerDriver.runQuery((config) => qb.toSql(config));
  return rows[0];
};

describe('Spanner JSON param encoding', () => {
  const dropTable = getDropTestTable(spannerDriver);

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    await dropTable(jsonParamsTable);
    await spannerDriver.getTableManager().loadTable(jsonParamsTable);
  }, 60000);

  afterAll(async () => {
    await dropTable(jsonParamsTable);
    await SpannerEmulatorProvisioner.release();
  }, 60000);

  test('the value Spanner refused as a JSON param: 0.915908 does not round-trip its exact-mode parser', async () => {
    await expect(
      assertSpannerExactModeAccepts([{ sql: '', params: { p: { cost: 0.915908 } }, types: { p: 'json' } }])
    ).rejects.toThrow(/cannot round-trip through string representation/);
  }, 60000);

  test('an insert carrying 0.915908 binds so that exact-mode Spanner accepts it, and reads back identical', async () => {
    let id = '';
    const statements = await wireStatementsOf(async () => {
      id = await insertRow({ cost: 0.915908 });
    });
    expect(statements.length).toBeGreaterThan(0);
    await assertSpannerExactModeAccepts(statements);
    expect((await selectRow(id))?.payload).toEqual({ cost: 0.915908 });
  }, 60000);

  test('nested numbers Spanner canonicalizes to more digits read back as the same JS doubles', async () => {
    const payload = {
      model: 'm',
      cost: { inputUsd: 1.4811355, cachedInputUsd: 0.915908, totalUsd: 2.1766105 },
      steps: [{ usd: 297.3344693281405 }, { usd: 0.1 + 0.2 }, { usd: 1.2345678901234568e20 }],
    };
    let id = '';
    const statements = await wireStatementsOf(async () => {
      id = await insertRow(payload);
    });
    await assertSpannerExactModeAccepts(statements);
    expect((await selectRow(id))?.payload).toEqual(payload);
  }, 60000);

  test('an update carrying a refused value binds the same way through the normal update path', async () => {
    const id = await insertRow({ cost: 0 });
    let updated = 0;
    const statements = await wireStatementsOf(async () => {
      updated = await updateRow(id, { cost: 0.915908, settled: true });
    });
    expect(updated).toBe(1);
    await assertSpannerExactModeAccepts(statements);
    expect((await selectRow(id))?.payload).toEqual({ cost: 0.915908, settled: true });
  }, 60000);

  test('a null JSON value writes and reads back as null', async () => {
    const id = await insertRow(null);
    expect((await selectRow(id))?.payload).toBeNull();
    expect(await updateRow(id, { cost: 0.5 })).toBe(1);
    expect(await updateRow(id, null)).toBe(1);
    expect((await selectRow(id))?.payload).toBeNull();
  }, 60000);
});
