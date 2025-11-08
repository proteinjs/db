import { Table } from '@proteinjs/db';
import { KnexDriver } from '../../src/KnexDriver';

export const getDropTestTable = (knexDriver: KnexDriver) => {
  return async (table: Table<any>) => {
    if (await knexDriver.getKnex().schema.withSchema(knexDriver.getDbName()).hasTable(table.name)) {
      await knexDriver.getKnex().schema.withSchema(knexDriver.getDbName()).dropTable(table.name);
    }
  };
};
