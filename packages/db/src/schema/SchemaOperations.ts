import { Table } from '../Table';

export interface SchemaOperations {
  createTable(table: Table<any>): Promise<void>;
  alterTable(table: Table<any>, changes: TableChanges): Promise<void>;
}

interface Index {
  name?: string;
  columns: string | string[];
  unique?: boolean;
}

interface ForeignKey {
  table: string; // table that is referenced
  column: string; // column that is referenced
  referencedByColumn: string; // column the constraint is applied to
}

interface ColumnTypeChange {
  name: string;
  newType: string;
}

interface ColumnNullableChange {
  name: string;
  nullable: boolean;
}

export interface TableChanges {
  columnsToCreate: string[];
  columnsToRename: string[];
  columnsToAlter: string[];
  columnTypeChanges: ColumnTypeChange[];
  columnNullableChanges: ColumnNullableChange[];
  columnsWithForeignKeysToCreate: string[];
  foreignKeysToCreate: ForeignKey[];
  columnsWithForeignKeysToDrop: string[];
  foreignKeysToDrop: ForeignKey[];
  columnsWithUniqueConstraintsToCreate: string[];
  columnsWithUniqueConstraintsToDrop: string[];
  indexesToCreate: Index[];
  indexesToDrop: Index[];
}
