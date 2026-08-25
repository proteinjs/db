import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { FloatColumn, Record, StatementFactory, Table, tableByName, withRecordColumns } from '@proteinjs/db';
import { QueryBuilder } from '@proteinjs/db-query';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * FLOAT64 param encoding through the driver's normal statement path (2026-08-24 sandbox cost
 * telemetry defect: every provision's `compute_seconds=0` insert failed with "Could not parse 0
 * as a FLOAT64"). The client codec stringifies integral JS numbers into the INT64 wire encoding
 * regardless of the declared param type, so `0` and `7` were rejected while `0.5` passed — the
 * driver must bind FLOAT64 params from the COLUMN type, never the value's integralness.
 */

interface Float64ParamsRecord extends Record {
  computeSeconds: number;
}

class Float64ParamsTable extends Table<Float64ParamsRecord> {
  name = 'db_test_float64_params';
  columns = withRecordColumns<Float64ParamsRecord>({
    computeSeconds: new FloatColumn('computeSeconds'),
  });
}

const float64ParamsTable = new Float64ParamsTable();

const spannerDriver = new SpannerDriver(
  {
    projectId: 'proteinjs-test',
    instanceName: 'proteinjs-test',
    databaseName: 'test',
  },
  (name) => (name === float64ParamsTable.name ? float64ParamsTable : tableByName(name))
);

/** Per-run unique row ids — fixtures never collide across runs or with leftover rows. */
const uniqueId = () => `f64-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The production insert shape (Db.insert): StatementFactory against the driver's own config. */
const insertRow = async (computeSeconds: number): Promise<string> => {
  const id = uniqueId();
  await spannerDriver.runDml((config) =>
    new StatementFactory<Float64ParamsRecord>().insert(
      float64ParamsTable.name,
      { id, computeSeconds } as Partial<Float64ParamsRecord>,
      config
    )
  );
  return id;
};

const selectRow = async (id: string): Promise<Float64ParamsRecord | undefined> => {
  const qb = new QueryBuilder<Float64ParamsRecord>(float64ParamsTable.name).condition({
    field: 'id',
    operator: '=',
    value: id,
  });
  const rows = await spannerDriver.runQuery((config) => qb.toSql(config));
  return rows[0];
};

describe('Spanner FLOAT64 param encoding', () => {
  const dropTable = getDropTestTable(spannerDriver);

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned({
      projectId: 'proteinjs-test',
      instanceName: 'proteinjs-test',
      databaseName: 'test',
    });
    await dropTable(float64ParamsTable);
    await spannerDriver.getTableManager().loadTable(float64ParamsTable);
  }, 60000);

  afterAll(async () => {
    await dropTable(float64ParamsTable);
    await SpannerEmulatorProvisioner.release();
  }, 60000);

  test('writes 0 into a FLOAT64 column (the telemetry failure shape)', async () => {
    const id = await insertRow(0);
    const row = await selectRow(id);
    expect(row?.computeSeconds).toBe(0);
  }, 60000);

  test('writes an integral non-zero value (7) into a FLOAT64 column', async () => {
    const id = await insertRow(7);
    const row = await selectRow(id);
    expect(row?.computeSeconds).toBe(7);
  }, 60000);

  test('writes a fractional value (0.5) into a FLOAT64 column (control)', async () => {
    const id = await insertRow(0.5);
    const row = await selectRow(id);
    expect(row?.computeSeconds).toBe(0.5);
  }, 60000);

  test('queries by an integral FLOAT64 condition value through the normal query path', async () => {
    const marker = 12345;
    const id = await insertRow(marker);
    const qb = new QueryBuilder<Float64ParamsRecord>(float64ParamsTable.name).condition({
      field: 'computeSeconds',
      operator: '=',
      value: marker,
    });
    const rows = await spannerDriver.runQuery((config) => qb.toSql(config));
    expect(rows.map((row) => row.id)).toContain(id);
  }, 60000);

  test('updates a FLOAT64 column to an integral value through the normal update path', async () => {
    const id = await insertRow(0.5);
    const qb = new QueryBuilder<Float64ParamsRecord>(float64ParamsTable.name).condition({
      field: 'id',
      operator: '=',
      value: id,
    });
    const updatedCount = await spannerDriver.runDml((config) =>
      new StatementFactory<Float64ParamsRecord>().update(
        float64ParamsTable.name,
        { computeSeconds: 0 } as Partial<Float64ParamsRecord>,
        qb,
        config
      )
    );
    expect(updatedCount).toBe(1);
    const row = await selectRow(id);
    expect(row?.computeSeconds).toBe(0);
  }, 60000);
});
