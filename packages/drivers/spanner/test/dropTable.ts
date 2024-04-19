import { StatementFactory, Table } from '@proteinjs/db';
import { SpannerDriver } from '../src/SpannerDriver';

export const getDropTable = (spannerDriver: SpannerDriver) => {
  return async (table: Table<any>) => {
    // console.info(`Dropping table: ${table.name}`);
    const tableManager = spannerDriver.getTableManager();
    if (await tableManager.schemaMetadata.tableExists(table)) {
      const foreignKeys = await tableManager.schemaMetadata.getForeignKeys(table);
      for (let columnName in foreignKeys) {
        const foreignKey = foreignKeys[columnName];
        await spannerDriver.runUpdateSchema(new StatementFactory().dropForeignKey(table.name, { table: foreignKey.referencedTableName, column: foreignKey.referencedColumnName, referencedByColumn: columnName }).sql);
      }

      const indexes = await tableManager.schemaMetadata.getIndexes(table);
      // console.info(`Indexes: ${JSON.stringify(indexes, null, 2)}`)
      for (let indexName in indexes) {
        if (indexName == 'PRIMARY_KEY')
          continue;

        try {
          // console.info(`Dropping index: ${indexName}`);
          await spannerDriver.runUpdateSchema(new StatementFactory().dropIndex({ name: indexName, columns: indexes[indexName] }, table.name).sql);
        } catch (error: any) {
          console.error(`Failed to drop index: ${indexName}\nreason: ${error.details}`);
        }
      }
      await spannerDriver.runUpdateSchema(`DROP TABLE ${table.name}`);
      // console.info(`Dropped table: ${table.name}`);
    }
  }
}