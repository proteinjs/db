import { Table } from '../Table';

export interface SchemaOperations {
  /**
   * Create every table in `tables`, in the given order. The order is load-bearing: a table whose
   * foreign keys reference another absent table must appear after it. Drivers that support batched
   * DDL (Spanner) apply the whole set as ONE schema-update operation — statements inside a batch
   * apply in order, so the ordering contract is preserved.
   */
  createTables(tables: Table<any>[]): Promise<void>;
  alterTable(table: Table<any>, changes: TableChanges): Promise<void>;

  /**
   * Classify a create/alter DDL error as the backend's "already exists" class — the loser's
   * outcome when two actors concurrently create the same table/index or add the same column and
   * the backend serializes the DDL so the object lands exactly once. Backend-specific (each driver
   * owns its error codes/messages), so it is optional: a driver that does not implement it opts out
   * of {@link TableManager}'s concurrent-reconcile tolerance and keeps the strict rethrow.
   *
   * MUST match on error CLASS (status code + a specific message class), never a loose substring —
   * it decides whether a failure is eligible for verify-then-succeed, and a genuine failure that
   * slipped into this class would be masked. The tolerance is still safe because TableManager
   * re-reads and confirms the intended definition before treating it as success; this predicate is
   * the first gate, not the whole guard.
   */
  isAlreadyExistsError?(error: unknown): boolean;
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
