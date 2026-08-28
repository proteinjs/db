import { DataEncryptionKeyTable, EncryptedColumns, Table, TableManager } from '@proteinjs/db';
import { cascadeDeleteTestTables } from '@proteinjs/db/test';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';

/**
 * Schema loading for the column-encryption suites. `Db.delete` consults the reverse-cascade
 * edge index over the WHOLE static table registry, and dynamic-reference edges are
 * target-agnostic — so a delete from ANY table queries every registered table holding a
 * `reverseCascadeDelete` dynamic-reference column (the cascade-delete test tables). A
 * single-file run must therefore create those alongside the suite's own tables, plus the
 * framework's data-key table. Serial `loadTable` (never batch `loadTables`): the registry
 * deliberately holds same-name table pairs for schema-change tests, which a batch create
 * would collide on.
 *
 * @internal This module is intended to be used only in tests.
 */
export const loadColumnEncryptionTestSchema = async (
  tableManager: TableManager,
  suiteTables: Table<any>[]
): Promise<void> => {
  const tables: Table<any>[] = [
    ...Object.values(cascadeDeleteTestTables),
    new DataEncryptionKeyTable(),
    ...suiteTables,
  ];
  for (const table of tables) {
    await tableManager.loadTable(table);
  }
};

/**
 * Clean-slate purge of a suite's tables (rows + their derived token tables) in beforeAll:
 * a prior run killed mid-flight (or a teardown starved out by shared-emulator contention)
 * leaves seeded rows behind, and exact-match search assertions must never depend on a
 * previous process having exited cleanly.
 */
export const purgeColumnEncryptionTestRows = async (
  spannerDriver: SpannerDriver,
  suiteTables: Table<any>[]
): Promise<void> => {
  const encryptedColumns = new EncryptedColumns();
  const tables: Table<any>[] = [];
  for (const table of suiteTables) {
    tables.push(table);
    const tokenTable = encryptedColumns.tokenTableFor(table);
    if (tokenTable) {
      tables.push(tokenTable);
    }
  }

  for (const table of tables) {
    await spannerDriver.runDml(() => ({ sql: `DELETE FROM \`${table.name}\` WHERE TRUE` }));
  }
};
