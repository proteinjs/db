import { Table, tableManagerTests } from '@proteinjs/db'
import { KnexDriver } from '../src/KnexDriver'
import { KnexColumnTypeFactory } from '../src/KnexColumnTypeFactory';

const knexDriver = new KnexDriver({
	host: 'localhost',
	user: 'root',
	password: '',
	dbName: 'test',
});
const dropTable = async (table: Table<any>) => {
  if (await knexDriver.getKnex().schema.withSchema(knexDriver.getDbName()).hasTable(table.name))
		await knexDriver.getKnex().schema.withSchema(knexDriver.getDbName()).dropTable(table.name);
}

describe(
	'Table Manager Tests',
	tableManagerTests(
		knexDriver,
		dropTable,
		new KnexColumnTypeFactory().getType
	)
);