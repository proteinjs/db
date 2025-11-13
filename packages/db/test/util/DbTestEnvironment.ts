import { Table, DbDriver } from '@proteinjs/db';
import { cascadeDeleteTestTables } from './tables/cascadeDeleteTestTables';
import { columnTypesTestTables } from './tables/columnTypesTestTables';
import { crudTestTables } from './tables/crudTestTables';
import { dynamicReferenceTestTables } from './tables/dynamicReferenceColumnTestTables';
import { tableManagerTestTables } from './tables/tableManagerTestTables';
import { transactionTestTables } from './tables/transactionTestTables';

const TABLES: Table<any>[] = [
  ...Object.values(cascadeDeleteTestTables),
  ...Object.values(columnTypesTestTables),
  ...Object.values(crudTestTables),
  ...Object.values(dynamicReferenceTestTables),
  ...Object.values(tableManagerTestTables),
  ...Object.values(transactionTestTables),
];

/**
 * Convenience functions for setting up a test environment
 */
export class DbTestEnvironment {
  constructor(
    private dbDriver: DbDriver,
    private dropTestTable: (table: Table<any>) => Promise<void>
  ) {}

  async beforeAll() {
    if (this.dbDriver.start) {
      await this.dbDriver.start();
    }

    for (const table of TABLES) {
      await this.dbDriver.getTableManager().loadTable(table);
    }
  }

  async afterAll() {
    for (const table of TABLES.reverse()) {
      await this.dropTestTable(table);
    }

    if (this.dbDriver.stop) {
      await this.dbDriver.stop();
    }
  }
}
