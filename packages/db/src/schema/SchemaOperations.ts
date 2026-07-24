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
  /** The column's current type in the live schema — lets drivers distinguish legal in-place changes (e.g. Spanner STRING widening) from impossible ones. */
  oldType: string;
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
