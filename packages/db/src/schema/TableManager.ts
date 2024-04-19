import { Logger } from '@proteinjs/util';
import { Column, Table, getTables, tableByName } from '../Table';
import { SchemaOperations, TableChanges } from './SchemaOperations';
import { SchemaMetadata } from './SchemaMetadata';
import { DbDriver } from '../Db';

export interface ColumnTypeFactory {
  getType(column: Column<any, any>): string;
}

export class TableManager {
	private logger = new Logger(this.constructor.name);
	public columnTypeFactory: ColumnTypeFactory;
	public schemaOperations: SchemaOperations;
	public schemaMetadata: SchemaMetadata;

	constructor(
		dbDriver: DbDriver,
		columnTypeFactory: ColumnTypeFactory,
		schemaOperations: SchemaOperations,
		schemaMetadata?: SchemaMetadata
	){
		this.columnTypeFactory = columnTypeFactory;
		this.schemaOperations = schemaOperations;
		this.schemaMetadata = schemaMetadata ? schemaMetadata : new SchemaMetadata(dbDriver);
	}

	async tableExists(table: Table<any>) {
		return await this.schemaMetadata.tableExists(table);
	}

	async loadTables(): Promise<void> {
		const tables = getTables();
		for (const table of tables)
			await this.loadTable(table);
	}

	async loadTable(table: Table<any>): Promise<void> {
		if (await this.tableExists(table)) {
			const tableChanges = await this.getTableChanges(table);
			if (this.shouldAlterTable(tableChanges)) {
				this.logger.info(`Altering table: ${table.name}`);
				await this.schemaOperations.alterTable(table, tableChanges);
				this.logger.info(`Finished altering table: ${table.name}`);
			}
		} else {
			this.logger.info(`Creating table: ${table.name}`);
			await this.schemaOperations.createTable(table);
			this.logger.info(`Finished creating table: ${table.name}`);
		}
	}

	private shouldAlterTable(tableChanges: TableChanges) {
		if (
			tableChanges.columnsToCreate.length == 0 && 
			tableChanges.columnsToRename.length == 0 && 
			tableChanges.columnsToAlter.length == 0 &&
			tableChanges.columnsWithForeignKeysToDrop.length == 0 &&
			tableChanges.columnsWithUniqueConstraintsToDrop.length == 0 &&
			tableChanges.indexesToCreate.length == 0 &&
			tableChanges.indexesToDrop.length == 0
		)
			return false;

		return true;
	}

	private async getTableChanges(table: Table<any>) {
		const { indexesToCreate, indexesToDrop } = await this.getIndexOperations(table);
		const tableChanges: TableChanges = {
			columnsToCreate: [],
			columnsToRename: [],
			columnsToAlter: [],
			columnTypeChanges: [],
			columnNullableChanges: [],
			columnsWithForeignKeysToCreate: [],
			foreignKeysToCreate: [],
			columnsWithForeignKeysToDrop: [],
			foreignKeysToDrop: [],
			columnsWithUniqueConstraintsToCreate: [],
			columnsWithUniqueConstraintsToDrop: [],
			indexesToCreate,
			indexesToDrop,
		};

		const columnMetadata = await this.schemaMetadata.getColumnMetadata(table);
		const uniqueColumns = await this.schemaMetadata.getUniqueColumns(table);
		const foreignKeys = await this.schemaMetadata.getForeignKeys(table);
		for (const columnPropertyName in table.columns) {
			const column = table.columns[columnPropertyName];
			if (columnMetadata[column.name]) {
				let alter = false;
				const columnType = this.columnTypeFactory.getType(column);
				const existingColumnType = columnMetadata[column.name].type;
				if (columnType != existingColumnType) {
					// console.log(`columnType != existingColumnType`);
					tableChanges.columnTypeChanges.push({ name: column.name, newType: columnType });
					alter = true;
				}
				
				if (
					(column.options?.nullable && !columnMetadata[column.name].isNullable) ||
					(column.options?.nullable === false && columnMetadata[column.name].isNullable)
				) {
					// console.log(`column.options?.nullable`)
					tableChanges.columnNullableChanges.push({ name: column.name, nullable: column.options.nullable === true });
					alter = true;
				}
				
				if (
					column.options?.unique?.unique === false && uniqueColumns.includes(column.name)
				) {
					// console.log(`column.options?.unique?.unique`)
					tableChanges.columnsWithUniqueConstraintsToDrop.push(column.name);
					alter = true;
				} else if (
					column.options?.unique?.unique && !uniqueColumns.includes(column.name)
				) {
					tableChanges.columnsWithUniqueConstraintsToCreate.push(column.name);
					alter = true;
				}
				
				if (
					!column.options?.references && foreignKeys[column.name] ||
					column.options?.references && foreignKeys[column.name] && foreignKeys[column.name].referencedTableName != column.options.references.table
				) {
					// console.log(`column.options?.references`)
					tableChanges.columnsWithForeignKeysToDrop.push(column.name);
					tableChanges.foreignKeysToDrop.push({ table: foreignKeys[column.name].referencedTableName, column: foreignKeys[column.name].referencedColumnName, referencedByColumn: column.name });
					alter = true;
				} else if (
					column.options?.references && !foreignKeys[column.name]
				) {
					tableChanges.columnsWithForeignKeysToCreate.push(column.name);
					tableChanges.foreignKeysToCreate.push({ table: column.options.references.table, column: 'id', referencedByColumn: column.name });
					alter = true;
				}
	
				if (alter)
					tableChanges.columnsToAlter.push(columnPropertyName);
	
				continue;
			}
	
			if (column.oldName && columnMetadata[column.oldName]) {
				tableChanges.columnsToRename.push(columnPropertyName);
				continue;
			}		
	
			tableChanges.columnsToCreate.push(columnPropertyName);
		}

		return tableChanges;
	}

	private async getIndexOperations(table: Table<any>) {
    const existingIndexes = await this.schemaMetadata.getIndexes(table);
    const indexesToDrop: {
			name?: string;
			columns: string|string[];
			unique?: boolean;
		}[] = [];
    const indexesToCreate: {
			name?: string;
			columns: string|string[];
			unique?: boolean;
		}[] = [];
    const currentIndexMap: {[serializedColumns: string]: boolean} = {};
    const existingIndexMap: {[serializedColumns: string]: boolean} = {};
		for (const keyName in existingIndexes)
      existingIndexMap[JSON.stringify(existingIndexes[keyName])] = true;
  
    if (table.indexes) {
      for (const index of table.indexes) {
        const serializedColumns = JSON.stringify(index.columns);
        currentIndexMap[serializedColumns] = true;
        if (!existingIndexMap[serializedColumns])
          indexesToCreate.push({ name: index.name, columns: index.columns as string[] });
      }
    }
  
    for (const keyName in existingIndexes) {
      const existingIndex = existingIndexes[keyName];
      const serializedColumns = JSON.stringify(existingIndex);
      if (
				!currentIndexMap[serializedColumns] && 
				keyName != 'PRIMARY' &&
				keyName != 'PRIMARY_KEY' &&
				!keyName.endsWith('_unique') &&
				!keyName.endsWith('_foreign') &&
				!keyName.startsWith('IDX_')
			)
        indexesToDrop.push({ name: keyName, columns: existingIndex });
    }
  
    return { indexesToCreate, indexesToDrop };
  }
}