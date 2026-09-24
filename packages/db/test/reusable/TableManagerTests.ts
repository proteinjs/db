import {
  DateColumn,
  DateTimeColumn,
  DecimalColumn,
  FloatColumn,
  IntegerColumn,
  ObjectColumn,
  StringColumn,
  UuidColumn,
  DbDriver,
  Column,
  Table,
  withRecordColumns,
} from '@proteinjs/db';
import { SourceRepository } from '@proteinjs/reflection';
import { DbTestEnvironment } from '../util/DbTestEnvironment';
import {
  ColumnTypesTable,
  MappedIndexUser,
  MappedIndexUserTable,
  tableManagerTestTables,
  UserTestTable,
} from '../util/tables/tableManagerTestTables';

export const tableManagerTests = (
  driver: DbDriver,
  dropTable: (table: Table<any>) => Promise<void>,
  getColumnType: (column: Column<any, any>) => string,
  excludedTests?: {
    alterColumnName?: boolean;
    alterColumnTypes?: boolean;
    alterNullableConstraint?: boolean;
  }
) => {
  return () => {
    const tableManager = driver.getTableManager();
    const testEnv = new DbTestEnvironment(driver, dropTable);

    beforeAll(async () => await testEnv.beforeAll(), 120000);
    afterAll(async () => await testEnv.afterAll(), 120000);

    afterEach(async () => {
      await dropTable(tableManagerTestTables.ColumnTypes);
      await dropTable(tableManagerTestTables.User);
      await dropTable(tableManagerTestTables.MappedIndexUser);
    });

    test('create primary key', async () => {
      const userTable = new UserTestTable();
      await tableManager.loadTable(userTable);
      expect(await tableManager.tableExists(userTable)).toBeTruthy();
      const primaryKey = await tableManager.schemaMetadata.getPrimaryKey(userTable);
      expect(primaryKey[0]).toBe('id');
      expect(primaryKey.length).toBe(1);
    });

    test('create columns', async () => {
      const userTable = new UserTestTable();
      await tableManager.loadTable(userTable);
      expect(await tableManager.tableExists(userTable)).toBeTruthy();
      expect(await tableManager.schemaMetadata.columnExists(userTable.columns.name.name, userTable)).toBeTruthy();
      expect(await tableManager.schemaMetadata.columnExists(userTable.columns.email.name, userTable)).toBeTruthy();
      expect(await tableManager.schemaMetadata.columnExists(userTable.columns.active.name, userTable)).toBeTruthy();
    });

    test('add column via alter', async () => {
      const userTable = new UserTestTable();
      const dataColumn = new ObjectColumn('data');
      await tableManager.loadTable(userTable);
      expect(await tableManager.tableExists(userTable)).toBeTruthy();
      expect(await tableManager.schemaMetadata.columnExists(userTable.columns.name.name, userTable)).toBeTruthy();
      expect(await tableManager.schemaMetadata.columnExists(userTable.columns.email.name, userTable)).toBeTruthy();
      expect(await tableManager.schemaMetadata.columnExists(userTable.columns.active.name, userTable)).toBeTruthy();
      expect(await tableManager.schemaMetadata.columnExists(dataColumn.name, userTable)).toBeFalsy();
      (userTable as Table<any>).columns['data'] = dataColumn;
      await tableManager.loadTable(userTable);
      expect(await tableManager.tableExists(userTable)).toBeTruthy();
      expect(await tableManager.schemaMetadata.columnExists(userTable.columns.name.name, userTable)).toBeTruthy();
      expect(await tableManager.schemaMetadata.columnExists(userTable.columns.email.name, userTable)).toBeTruthy();
      expect(await tableManager.schemaMetadata.columnExists(userTable.columns.active.name, userTable)).toBeTruthy();
      expect(await tableManager.schemaMetadata.columnExists(dataColumn.name, userTable)).toBeTruthy();
    });

    test('columns created with correct types', async () => {
      const userTable = new UserTestTable();
      const columnTypesTable = new ColumnTypesTable();
      await tableManager.loadTable(userTable);
      await tableManager.loadTable(columnTypesTable);
      expect(await tableManager.tableExists(columnTypesTable)).toBeTruthy();
      const columnMetadata = await tableManager.schemaMetadata.getColumnMetadata(columnTypesTable);
      expect(columnMetadata[columnTypesTable.columns.integer.name].type).toBe(
        getColumnType(columnTypesTable.columns.integer)
      );
      expect(columnMetadata[columnTypesTable.columns.bigInteger.name].type).toBe(
        getColumnType(columnTypesTable.columns.bigInteger)
      );
      expect(columnMetadata[columnTypesTable.columns.text.name].type).toBe(
        getColumnType(columnTypesTable.columns.text)
      );
      expect(columnMetadata[columnTypesTable.columns.string.name].type).toBe(
        getColumnType(columnTypesTable.columns.string)
      );
      expect(columnMetadata[columnTypesTable.columns.float.name].type).toBe(
        getColumnType(columnTypesTable.columns.float)
      );
      expect(columnMetadata[columnTypesTable.columns.decimal.name].type).toBe(
        getColumnType(columnTypesTable.columns.decimal)
      );
      expect(columnMetadata[columnTypesTable.columns.boolean.name].type).toBe(
        getColumnType(columnTypesTable.columns.boolean)
      );
      expect(columnMetadata[columnTypesTable.columns.date.name].type).toBe(
        getColumnType(columnTypesTable.columns.date)
      );
      expect(columnMetadata[columnTypesTable.columns.dateTime.name].type).toBe(
        getColumnType(columnTypesTable.columns.dateTime)
      );
      expect(columnMetadata[columnTypesTable.columns.binary.name].type).toBe(
        getColumnType(columnTypesTable.columns.binary)
      );
      expect(columnMetadata[columnTypesTable.columns.object.name].type).toBe(
        getColumnType(columnTypesTable.columns.object)
      );
      expect(columnMetadata[columnTypesTable.columns.uuid.name].type).toBe(
        getColumnType(columnTypesTable.columns.uuid)
      );
    });

    test('columns created with correct options', async () => {
      const userTable = new UserTestTable();
      const columnTypesTable = new ColumnTypesTable();
      await tableManager.loadTable(userTable);
      await tableManager.loadTable(columnTypesTable);
      expect(await tableManager.tableExists(userTable)).toBeTruthy();
      expect(await tableManager.tableExists(columnTypesTable)).toBeTruthy();

      const columnMetadata = await tableManager.schemaMetadata.getColumnMetadata(columnTypesTable);
      expect(columnMetadata[columnTypesTable.columns.integer.name].isNullable).toBeTruthy();
      expect(columnMetadata[columnTypesTable.columns.bigInteger.name].isNullable).toBeFalsy();
      // expect(parseFloat(columnMetadata[TestColumnTypesTable.columns.float.name]['COLUMN_DEFAULT'])).toBe(0.5);

      const foreignKeys = await tableManager.schemaMetadata.getForeignKeys(columnTypesTable);
      expect(foreignKeys[columnTypesTable.columns.string.name].referencedTableName).toBe(userTable.name);
      expect(foreignKeys[columnTypesTable.columns.string.name].referencedColumnName).toBe('id');

      const uniqueColumns = await tableManager.schemaMetadata.getUniqueColumns(columnTypesTable);
      expect(uniqueColumns.includes(columnTypesTable.columns.uuid.name)).toBeTruthy();
    });

    test('alter column name', async () => {
      if (excludedTests?.alterColumnName) {
        return;
      }

      const userTable = new UserTestTable();
      await tableManager.loadTable(userTable);
      expect(await tableManager.tableExists(userTable)).toBeTruthy();
      expect(await tableManager.schemaMetadata.columnExists(userTable.columns.name.name, userTable)).toBeTruthy();
      userTable.columns.name.oldName = 'name';
      userTable.columns.name.name = 'namo';
      await tableManager.loadTable(userTable);
      expect(await tableManager.schemaMetadata.columnExists('namo', userTable)).toBeTruthy();
      expect(await tableManager.schemaMetadata.columnExists('name', userTable)).toBeFalsy();
    });

    test('alter column types', async () => {
      if (excludedTests?.alterColumnTypes) {
        return;
      }

      const userTable = new UserTestTable();
      const columnTypesTable = new ColumnTypesTable();
      await tableManager.loadTable(userTable);
      await tableManager.loadTable(columnTypesTable);
      // const columnTypesTableIndexes = await tableManager.schemaMetadata.getIndexes(columnTypesTable);
      // console.log(`columnTypesTableIndexes:\n${JSON.stringify(columnTypesTableIndexes, null, 2)}`)
      expect(await tableManager.tableExists(userTable)).toBeTruthy();
      expect(await tableManager.tableExists(columnTypesTable)).toBeTruthy();
      columnTypesTable.columns.integer = new IntegerColumn('integer', { nullable: true }, true);
      columnTypesTable.columns.bigInteger = new IntegerColumn('big_integer', { nullable: false });
      columnTypesTable.columns.text = new StringColumn('text');
      // TestColumnTypesTable.columns.string = new UuidColumn('string', { references: { table: 'user', column: 'id' } });
      columnTypesTable.columns.float = new DecimalColumn('float', { defaultValue: async () => 0.5 });
      columnTypesTable.columns.decimal = new FloatColumn('decimal');
      columnTypesTable.columns.boolean = new IntegerColumn('boolean');
      (columnTypesTable as Table<any>).columns.date = new DateTimeColumn('date');
      columnTypesTable.columns.dateTime = new DateColumn('date_time');
      columnTypesTable.columns.binary = new StringColumn('binary');
      columnTypesTable.columns.uuid = new StringColumn('uuid', { unique: { unique: true } });
      await tableManager.loadTable(columnTypesTable);
      const columnMetadata = await tableManager.schemaMetadata.getColumnMetadata(columnTypesTable);
      expect(columnMetadata[columnTypesTable.columns.integer.name].type).toBe(
        getColumnType(columnTypesTable.columns.integer)
      );
      expect(columnMetadata[columnTypesTable.columns.bigInteger.name].type).toBe(
        getColumnType(columnTypesTable.columns.bigInteger)
      );
      expect(columnMetadata[columnTypesTable.columns.text.name].type).toBe(
        getColumnType(columnTypesTable.columns.text)
      );
      expect(columnMetadata[columnTypesTable.columns.string.name].type).toBe(
        getColumnType(columnTypesTable.columns.string)
      );
      expect(columnMetadata[columnTypesTable.columns.float.name].type).toBe(
        getColumnType(columnTypesTable.columns.float)
      );
      expect(columnMetadata[columnTypesTable.columns.decimal.name].type).toBe(
        getColumnType(columnTypesTable.columns.decimal)
      );
      expect(columnMetadata[columnTypesTable.columns.boolean.name].type).toBe(
        getColumnType(columnTypesTable.columns.boolean)
      );
      expect(columnMetadata[columnTypesTable.columns.date.name].type).toBe(
        getColumnType(columnTypesTable.columns.date)
      );
      expect(columnMetadata[columnTypesTable.columns.dateTime.name].type).toBe(
        getColumnType(columnTypesTable.columns.dateTime)
      );
      expect(columnMetadata[columnTypesTable.columns.binary.name].type).toBe(
        getColumnType(columnTypesTable.columns.binary)
      );
      expect(columnMetadata[columnTypesTable.columns.object.name].type).toBe(
        getColumnType(columnTypesTable.columns.object)
      );
      expect(columnMetadata[columnTypesTable.columns.uuid.name].type).toBe(
        getColumnType(columnTypesTable.columns.uuid)
      );
      const foreignKeys = await tableManager.schemaMetadata.getForeignKeys(columnTypesTable);
      const uniqueColumns = await tableManager.schemaMetadata.getUniqueColumns(columnTypesTable);
      expect(columnMetadata[columnTypesTable.columns.integer.name].isNullable).toBeTruthy();
      expect(columnMetadata[columnTypesTable.columns.bigInteger.name].isNullable).toBeFalsy();
      // expect(parseFloat(columnMetadata[TestColumnTypesTable.columns.float.name]['COLUMN_DEFAULT'])).toBe(0.5);
      expect(foreignKeys[columnTypesTable.columns.string.name].referencedTableName).toBe(userTable.name);
      expect(foreignKeys[columnTypesTable.columns.string.name].referencedColumnName).toBe('id');
      expect(uniqueColumns.includes(columnTypesTable.columns.uuid.name)).toBeTruthy();
    });

    test('alter unique constraint', async () => {
      const userTable = new UserTestTable();
      const columnTypesTable = new ColumnTypesTable();
      await tableManager.loadTable(userTable);
      columnTypesTable.columns.text.options = { defaultValue: async () => 'asdf' };
      (columnTypesTable as Table<any>).columns['string2'] = new StringColumn('string2', {
        references: { table: userTable.name },
      });
      await tableManager.loadTable(columnTypesTable);
      expect(await tableManager.tableExists(userTable)).toBeTruthy();
      expect(await tableManager.tableExists(columnTypesTable)).toBeTruthy();
      let columnMetadata = await tableManager.schemaMetadata.getColumnMetadata(columnTypesTable);
      expect(columnMetadata[columnTypesTable.columns.integer.name].type).toBe(
        getColumnType(columnTypesTable.columns.integer)
      );
      expect(columnMetadata[columnTypesTable.columns.bigInteger.name].type).toBe(
        getColumnType(columnTypesTable.columns.bigInteger)
      );
      expect(columnMetadata[columnTypesTable.columns.text.name].type).toBe(
        getColumnType(columnTypesTable.columns.text)
      );
      expect(columnMetadata[columnTypesTable.columns.string.name].type).toBe(
        getColumnType(columnTypesTable.columns.string)
      );
      expect(columnMetadata[columnTypesTable.columns.float.name].type).toBe(
        getColumnType(columnTypesTable.columns.float)
      );
      expect(columnMetadata[columnTypesTable.columns.decimal.name].type).toBe(
        getColumnType(columnTypesTable.columns.decimal)
      );
      expect(columnMetadata[columnTypesTable.columns.boolean.name].type).toBe(
        getColumnType(columnTypesTable.columns.boolean)
      );
      expect(columnMetadata[columnTypesTable.columns.date.name].type).toBe(
        getColumnType(columnTypesTable.columns.date)
      );
      expect(columnMetadata[columnTypesTable.columns.dateTime.name].type).toBe(
        getColumnType(columnTypesTable.columns.dateTime)
      );
      expect(columnMetadata[columnTypesTable.columns.binary.name].type).toBe(
        getColumnType(columnTypesTable.columns.binary)
      );
      expect(columnMetadata[columnTypesTable.columns.object.name].type).toBe(
        getColumnType(columnTypesTable.columns.object)
      );
      expect(columnMetadata[columnTypesTable.columns.uuid.name].type).toBe(
        getColumnType(columnTypesTable.columns.uuid)
      );
      expect(columnMetadata[(columnTypesTable as Table<any>).columns.string2.name].type).toBe(
        getColumnType((columnTypesTable as Table<any>).columns.string2)
      );
      const foreignKeys = await tableManager.schemaMetadata.getForeignKeys(columnTypesTable);
      let uniqueColumns = await tableManager.schemaMetadata.getUniqueColumns(columnTypesTable);
      expect(columnMetadata[columnTypesTable.columns.integer.name].isNullable).toBeTruthy();
      expect(columnMetadata[columnTypesTable.columns.bigInteger.name].isNullable).toBeFalsy();
      // expect(parseFloat(columnMetadata[TestColumnTypesTable.columns.float.name]['COLUMN_DEFAULT'])).toBe(0.5);
      expect(foreignKeys[columnTypesTable.columns.string.name].referencedTableName).toBe(userTable.name);
      expect(foreignKeys[columnTypesTable.columns.string.name].referencedColumnName).toBe('id');
      expect(uniqueColumns.includes(columnTypesTable.columns.uuid.name)).toBeTruthy();
      // columnTypesTable.columns.text = new TextColumn('text', { references: { table: userTable.name, column: 'id' } });
      delete columnTypesTable.columns.string.options?.references;
      // ((columnTypesTable as Table<any>).columns.string2.options as any).references = { table: userTable.name, column: 'name' };
      columnTypesTable.columns.float = new FloatColumn('float', { defaultValue: async () => 1.5 });
      columnTypesTable.columns.decimal = new DecimalColumn('decimal', { defaultValue: async () => 0 });
      columnTypesTable.columns.uuid = new UuidColumn('uuid', { unique: { unique: false } });
      await tableManager.loadTable(columnTypesTable);
      columnMetadata = await tableManager.schemaMetadata.getColumnMetadata(columnTypesTable);
      expect(columnMetadata[columnTypesTable.columns.integer.name].type).toBe(
        getColumnType(columnTypesTable.columns.integer)
      );
      expect(columnMetadata[columnTypesTable.columns.bigInteger.name].type).toBe(
        getColumnType(columnTypesTable.columns.bigInteger)
      );
      expect(columnMetadata[columnTypesTable.columns.text.name].type).toBe(
        getColumnType(columnTypesTable.columns.text)
      );
      expect(columnMetadata[columnTypesTable.columns.string.name].type).toBe(
        getColumnType(columnTypesTable.columns.string)
      );
      expect(columnMetadata[columnTypesTable.columns.float.name].type).toBe(
        getColumnType(columnTypesTable.columns.float)
      );
      expect(columnMetadata[columnTypesTable.columns.decimal.name].type).toBe(
        getColumnType(columnTypesTable.columns.decimal)
      );
      expect(columnMetadata[columnTypesTable.columns.boolean.name].type).toBe(
        getColumnType(columnTypesTable.columns.boolean)
      );
      expect(columnMetadata[columnTypesTable.columns.date.name].type).toBe(
        getColumnType(columnTypesTable.columns.date)
      );
      expect(columnMetadata[columnTypesTable.columns.dateTime.name].type).toBe(
        getColumnType(columnTypesTable.columns.dateTime)
      );
      expect(columnMetadata[columnTypesTable.columns.binary.name].type).toBe(
        getColumnType(columnTypesTable.columns.binary)
      );
      expect(columnMetadata[columnTypesTable.columns.object.name].type).toBe(
        getColumnType(columnTypesTable.columns.object)
      );
      expect(columnMetadata[columnTypesTable.columns.uuid.name].type).toBe(
        getColumnType(columnTypesTable.columns.uuid)
      );
      expect(columnMetadata[(columnTypesTable as Table<any>).columns.string2.name].type).toBe(
        getColumnType((columnTypesTable as Table<any>).columns.string2)
      );
      // expect(parseFloat(columnMetadata[TestColumnTypesTable.columns.float.name]['COLUMN_DEFAULT'])).toBe(1.5);
      // expect(parseFloat(columnMetadata[TestColumnTypesTable.columns.decimal.name]['COLUMN_DEFAULT'])).toBe(0);
      // foreignKeys = await tableManager.schemaMetadata.getForeignKeys(columnTypesTable);
      // expect(foreignKeys[TestColumnTypesTable.columns.string.name]).toBeFalsy();
      // expect(foreignKeys[TestColumnTypesTable.columns.string2.name]['REFERENCED_TABLE_NAME']).toBe('user');
      // expect(foreignKeys[TestColumnTypesTable.columns.string2.name]['REFERENCED_COLUMN_NAME']).toBe('name');
      // expect(foreignKeys[TestColumnTypesTable.columns.text.name]['REFERENCED_TABLE_NAME']).toBe('user');
      // expect(foreignKeys[TestColumnTypesTable.columns.text.name]['REFERENCED_COLUMN_NAME']).toBe('id');
      uniqueColumns = await tableManager.schemaMetadata.getUniqueColumns(columnTypesTable);
      expect(uniqueColumns.includes(columnTypesTable.columns.uuid.name)).toBeFalsy();
    });

    test('alter column nullable constraint', async () => {
      if (excludedTests?.alterNullableConstraint) {
        return;
      }

      const userTable = new UserTestTable();
      const columnTypesTable = new ColumnTypesTable();
      await tableManager.loadTable(userTable);
      columnTypesTable.columns.text.options = { defaultValue: async () => 'asdf' };
      (columnTypesTable as Table<any>).columns['string2'] = new StringColumn('string2', {
        references: { table: userTable.name },
      });
      await tableManager.loadTable(columnTypesTable);
      expect(await tableManager.tableExists(userTable)).toBeTruthy();
      expect(await tableManager.tableExists(columnTypesTable)).toBeTruthy();
      let columnMetadata = await tableManager.schemaMetadata.getColumnMetadata(columnTypesTable);
      expect(columnMetadata[columnTypesTable.columns.integer.name].type).toBe(
        getColumnType(columnTypesTable.columns.integer)
      );
      expect(columnMetadata[columnTypesTable.columns.bigInteger.name].type).toBe(
        getColumnType(columnTypesTable.columns.bigInteger)
      );
      expect(columnMetadata[columnTypesTable.columns.text.name].type).toBe(
        getColumnType(columnTypesTable.columns.text)
      );
      expect(columnMetadata[columnTypesTable.columns.string.name].type).toBe(
        getColumnType(columnTypesTable.columns.string)
      );
      expect(columnMetadata[columnTypesTable.columns.float.name].type).toBe(
        getColumnType(columnTypesTable.columns.float)
      );
      expect(columnMetadata[columnTypesTable.columns.decimal.name].type).toBe(
        getColumnType(columnTypesTable.columns.decimal)
      );
      expect(columnMetadata[columnTypesTable.columns.boolean.name].type).toBe(
        getColumnType(columnTypesTable.columns.boolean)
      );
      expect(columnMetadata[columnTypesTable.columns.date.name].type).toBe(
        getColumnType(columnTypesTable.columns.date)
      );
      expect(columnMetadata[columnTypesTable.columns.dateTime.name].type).toBe(
        getColumnType(columnTypesTable.columns.dateTime)
      );
      expect(columnMetadata[columnTypesTable.columns.binary.name].type).toBe(
        getColumnType(columnTypesTable.columns.binary)
      );
      expect(columnMetadata[columnTypesTable.columns.object.name].type).toBe(
        getColumnType(columnTypesTable.columns.object)
      );
      expect(columnMetadata[columnTypesTable.columns.uuid.name].type).toBe(
        getColumnType(columnTypesTable.columns.uuid)
      );
      expect(columnMetadata[(columnTypesTable as Table<any>).columns.string2.name].type).toBe(
        getColumnType((columnTypesTable as Table<any>).columns.string2)
      );
      const foreignKeys = await tableManager.schemaMetadata.getForeignKeys(columnTypesTable);
      const uniqueColumns = await tableManager.schemaMetadata.getUniqueColumns(columnTypesTable);
      expect(columnMetadata[columnTypesTable.columns.integer.name].isNullable).toBeTruthy();
      expect(columnMetadata[columnTypesTable.columns.bigInteger.name].isNullable).toBeFalsy();
      // expect(parseFloat(columnMetadata[TestColumnTypesTable.columns.float.name]['COLUMN_DEFAULT'])).toBe(0.5);
      expect(foreignKeys[columnTypesTable.columns.string.name].referencedTableName).toBe(userTable.name);
      expect(foreignKeys[columnTypesTable.columns.string.name].referencedColumnName).toBe('id');
      expect(uniqueColumns.includes(columnTypesTable.columns.uuid.name)).toBeTruthy();
      columnTypesTable.columns.integer = new IntegerColumn('integer', { nullable: false });
      columnTypesTable.columns.bigInteger = new IntegerColumn('big_integer', { nullable: true }, true);
      // columnTypesTable.columns.text = new TextColumn('text', { references: { table: userTable.name, column: 'id' } });
      delete columnTypesTable.columns.string.options?.references;
      // ((columnTypesTable as Table<any>).columns.string2.options as any).references = { table: userTable.name, column: 'name' };
      columnTypesTable.columns.float = new FloatColumn('float', { defaultValue: async () => 1.5 });
      columnTypesTable.columns.decimal = new DecimalColumn('decimal', { defaultValue: async () => 0 });
      await tableManager.loadTable(columnTypesTable);
      columnMetadata = await tableManager.schemaMetadata.getColumnMetadata(columnTypesTable);
      expect(columnMetadata[columnTypesTable.columns.integer.name].type).toBe(
        getColumnType(columnTypesTable.columns.integer)
      );
      expect(columnMetadata[columnTypesTable.columns.bigInteger.name].type).toBe(
        getColumnType(columnTypesTable.columns.bigInteger)
      );
      expect(columnMetadata[columnTypesTable.columns.text.name].type).toBe(
        getColumnType(columnTypesTable.columns.text)
      );
      expect(columnMetadata[columnTypesTable.columns.string.name].type).toBe(
        getColumnType(columnTypesTable.columns.string)
      );
      expect(columnMetadata[columnTypesTable.columns.float.name].type).toBe(
        getColumnType(columnTypesTable.columns.float)
      );
      expect(columnMetadata[columnTypesTable.columns.decimal.name].type).toBe(
        getColumnType(columnTypesTable.columns.decimal)
      );
      expect(columnMetadata[columnTypesTable.columns.boolean.name].type).toBe(
        getColumnType(columnTypesTable.columns.boolean)
      );
      expect(columnMetadata[columnTypesTable.columns.date.name].type).toBe(
        getColumnType(columnTypesTable.columns.date)
      );
      expect(columnMetadata[columnTypesTable.columns.dateTime.name].type).toBe(
        getColumnType(columnTypesTable.columns.dateTime)
      );
      expect(columnMetadata[columnTypesTable.columns.binary.name].type).toBe(
        getColumnType(columnTypesTable.columns.binary)
      );
      expect(columnMetadata[columnTypesTable.columns.object.name].type).toBe(
        getColumnType(columnTypesTable.columns.object)
      );
      expect(columnMetadata[columnTypesTable.columns.uuid.name].type).toBe(
        getColumnType(columnTypesTable.columns.uuid)
      );
      expect(columnMetadata[(columnTypesTable as Table<any>).columns.string2.name].type).toBe(
        getColumnType((columnTypesTable as Table<any>).columns.string2)
      );
      expect(columnMetadata[columnTypesTable.columns.integer.name].isNullable).toBeFalsy();
      expect(columnMetadata[columnTypesTable.columns.bigInteger.name].isNullable).toBeTruthy();
      // expect(parseFloat(columnMetadata[TestColumnTypesTable.columns.float.name]['COLUMN_DEFAULT'])).toBe(1.5);
      // expect(parseFloat(columnMetadata[TestColumnTypesTable.columns.decimal.name]['COLUMN_DEFAULT'])).toBe(0);
      // foreignKeys = await tableManager.schemaMetadata.getForeignKeys(columnTypesTable);
      // expect(foreignKeys[TestColumnTypesTable.columns.string.name]).toBeFalsy();
      // expect(foreignKeys[TestColumnTypesTable.columns.string2.name]['REFERENCED_TABLE_NAME']).toBe('user');
      // expect(foreignKeys[TestColumnTypesTable.columns.string2.name]['REFERENCED_COLUMN_NAME']).toBe('name');
      // expect(foreignKeys[TestColumnTypesTable.columns.text.name]['REFERENCED_TABLE_NAME']).toBe('user');
      // expect(foreignKeys[TestColumnTypesTable.columns.text.name]['REFERENCED_COLUMN_NAME']).toBe('id');
    });

    test('creates index with different column name mapping', async () => {
      const mappedIndexUserTable = new MappedIndexUserTable();
      await tableManager.loadTable(mappedIndexUserTable);
      expect(await tableManager.tableExists(mappedIndexUserTable)).toBeTruthy();
      const indexes = await tableManager.schemaMetadata.getIndexes(mappedIndexUserTable);
      expect(JSON.stringify(indexes['db_test_mapped_index_user_email_index'])).toBe(JSON.stringify(['email_address']));
      expect(JSON.stringify(indexes['db_test_mapped_index_user_status_email_index'])).toBe(
        JSON.stringify(['account_status', 'email_address'])
      );
    });

    test('alters index with different column name mapping', async () => {
      const mappedIndexUserTable = new MappedIndexUserTable();
      await tableManager.loadTable(mappedIndexUserTable);
      expect(await tableManager.tableExists(mappedIndexUserTable)).toBeTruthy();
      let indexes = await tableManager.schemaMetadata.getIndexes(mappedIndexUserTable);
      expect(JSON.stringify(indexes['db_test_mapped_index_user_email_index'])).toBe(JSON.stringify(['email_address']));
      expect(JSON.stringify(indexes['db_test_mapped_index_user_status_email_index'])).toBe(
        JSON.stringify(['account_status', 'email_address'])
      );
      mappedIndexUserTable.indexes = [
        {
          name: 'db_test_mapped_index_user_email_index',
          columns: ['emailAddress'] as (keyof MappedIndexUser)[],
        },
        {
          name: 'db_test_mapped_index_user_created_email_index',
          columns: ['createdOn', 'emailAddress'] as (keyof MappedIndexUser)[],
        },
      ];
      await tableManager.loadTable(mappedIndexUserTable);
      indexes = await tableManager.schemaMetadata.getIndexes(mappedIndexUserTable);
      expect(JSON.stringify(indexes['db_test_mapped_index_user_email_index'])).toBe(JSON.stringify(['email_address']));
      expect(JSON.stringify(indexes['db_test_mapped_index_user_created_email_index'])).toBe(
        JSON.stringify(['created_on', 'email_address'])
      );
      expect(JSON.stringify(indexes['db_test_mapped_index_user_status_email_index'])).toBeFalsy();
    });

    test('create index', async () => {
      const userTable = new UserTestTable();
      await tableManager.loadTable(userTable);
      expect(await tableManager.tableExists(userTable)).toBeTruthy();
      const indexes = await tableManager.schemaMetadata.getIndexes(userTable);
      expect(JSON.stringify(indexes['db_test_user_email_index'])).toBe(JSON.stringify(['email']));
      expect(JSON.stringify(indexes['db_test_user_active_email_index'])).toBe(JSON.stringify(['active', 'email']));
    });

    test('alter index', async () => {
      const userTable = new UserTestTable();
      await tableManager.loadTable(userTable);
      expect(await tableManager.tableExists(userTable)).toBeTruthy();
      let indexes = await tableManager.schemaMetadata.getIndexes(userTable);
      expect(JSON.stringify(indexes['db_test_user_email_index'])).toBe(JSON.stringify(['email']));
      expect(JSON.stringify(indexes['db_test_user_active_email_index'])).toBe(JSON.stringify(['active', 'email']));
      userTable.indexes = [
        { name: 'db_test_user_email_index', columns: ['email'] },
        { name: 'db_test_user_active_name_index', columns: ['active', 'name'] },
      ];
      await tableManager.loadTable(userTable);
      indexes = await tableManager.schemaMetadata.getIndexes(userTable);
      expect(JSON.stringify(indexes['db_test_user_email_index'])).toBe(JSON.stringify(['email']));
      expect(JSON.stringify(indexes['db_test_user_active_name_index'])).toBe(JSON.stringify(['active', 'name']));
      expect(JSON.stringify(indexes['db_test_user_active_email_index'])).toBeFalsy();
    });

    /**
     * `loadTables` creates every absent registered table in one pass, each table's foreign keys
     * declared inline on its CREATE. The registry's enumeration order says nothing about those
     * references, so these fixtures are enumerated with each referencing table FIRST — the order
     * that fails a fresh database unless the tables are ordered by their references first.
     */
    describe('loadTables creates absent tables in reference order', () => {
      const fixtures = createOrderFixtureTables();

      beforeEach(async () => {
        await dropFixtureTables(dropTable, fixtures);
      });

      afterEach(async () => {
        await dropFixtureTables(dropTable, fixtures);
      });

      test('a table enumerated before the table its foreign key references is created after it', async () => {
        await withEnumeratedTables([fixtures.child, fixtures.parent], () => tableManager.loadTables());

        expect(await tableManager.tableExists(fixtures.parent)).toBe(true);
        expect(await tableManager.tableExists(fixtures.child)).toBe(true);
        const foreignKeys = await tableManager.schemaMetadata.getForeignKeys(fixtures.child);
        expect(foreignKeys['parent_id']?.referencedTableName).toBe(fixtures.parent.name);
        expect(foreignKeys['parent_id']?.referencedColumnName).toBe('id');
      });

      test('a reference cycle among absent tables is refused by name, and nothing is created', async () => {
        const created = withEnumeratedTables([fixtures.cycleA, fixtures.cycleB], () => tableManager.loadTables());

        await expect(created).rejects.toThrow(
          `foreign keys form a cycle: ${fixtures.cycleA.name} -> ${fixtures.cycleB.name} -> ${fixtures.cycleA.name}`
        );
        expect(await tableManager.tableExists(fixtures.cycleA)).toBe(false);
        expect(await tableManager.tableExists(fixtures.cycleB)).toBe(false);
      });
    });
  };
};

/**
 * Fixture tables for the reference-order tests. Anonymous classes on purpose: a named class
 * extending `Table` in this package's test sources joins the reflection registry, and a
 * registered reference cycle would be refused by every `loadTables` in the suites.
 */
const createOrderFixtureTables = () => {
  const referencing = (tableName: string, referencedTable: string): Table<any> =>
    new (class extends Table<any> {
      name = tableName;
      columns = withRecordColumns<any>({
        label: new StringColumn('label'),
        parentId: new StringColumn('parent_id', { references: { table: referencedTable } }),
      });
    })();

  return {
    parent: new (class extends Table<any> {
      name = 'db_test_create_order_parent';
      columns = withRecordColumns<any>({
        label: new StringColumn('label'),
      });
    })() as Table<any>,
    child: referencing('db_test_create_order_child', 'db_test_create_order_parent'),
    cycleA: referencing('db_test_create_order_cycle_a', 'db_test_create_order_cycle_b'),
    cycleB: referencing('db_test_create_order_cycle_b', 'db_test_create_order_cycle_a'),
  };
};

/** Referencing tables before the tables they reference, so a foreign key never blocks a drop. */
const dropFixtureTables = async (
  dropTable: (table: Table<any>) => Promise<void>,
  fixtures: ReturnType<typeof createOrderFixtureTables>
) => {
  for (const table of [fixtures.child, fixtures.parent, fixtures.cycleA, fixtures.cycleB]) {
    await dropTable(table);
  }
};

/**
 * Run `load` with the reflection registry enumerating exactly `tables` as the registered tables,
 * in that order — what a package declaring them in that order hands `TableManager.loadTables`.
 */
const withEnumeratedTables = async (tables: Table<any>[], load: () => Promise<void>) => {
  const repository = SourceRepository.get();
  const enumerate = repository.objects.bind(repository);
  const objects = jest
    .spyOn(repository, 'objects')
    .mockImplementation(((type: string) => (type === '@proteinjs/db/Table' ? tables : enumerate(type))) as any);
  try {
    await load();
  } finally {
    objects.mockRestore();
  }
};
