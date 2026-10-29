import { Table } from '../Table';

export interface SchemaOperations {
  /**
   * Create every table in `tables`, in the given order. The order is load-bearing: a table whose
   * foreign keys reference another absent table must appear after it — `TableManager` owns that
   * order and hands the set over already sorted by reference, so drivers never re-order. Drivers
   * that support batched DDL (Spanner) apply the whole set as ONE schema-update operation —
   * statements inside a batch apply in order, so the ordering contract is preserved.
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

/**
 * A type change a driver must make or refuse: the live type is NARROWER than declared (the widening
 * a driver may do in place) or a DIFFERENT type. A live type wider than declared is never one of
 * these — it is left as it stands ({@link ToleratedColumnDifference}).
 */
export interface ColumnTypeChange {
  name: string;
  newType: string;
  /** The column's current type in the live schema — lets drivers distinguish legal in-place changes (e.g. Spanner STRING widening) from impossible ones. */
  oldType: string;
  /**
   * Whether the column is nullable in the live schema. A backend whose in-place type change
   * restates the whole column definition (Spanner's ALTER COLUMN) restates THIS, never the
   * declared nullability: a nullability the declaration differs on is left as it stands
   * ({@link ToleratedColumnDifference}), so a widening never tightens or relaxes it on the side.
   */
  nullable: boolean;
}

/**
 * A difference between a declared column and its live column that the schema sync LEAVES AS IT
 * STANDS. The schema only moves forward: a build whose declaration asks for less than the live
 * column already gives — an older build serving after a rollback, before the next release re-runs
 * its migrations — must boot and serve, so the sync never narrows a column, never tightens or
 * relaxes its nullability, and never fails on a live schema that is a superset of what it declares.
 * `TableManager` names each once per sync and continues; none reaches a driver as a change.
 * - `wider-type`: the live type is a wider width of the declared type's family (a live STRING(MAX)
 *   where STRING(500) is declared) — every value the build writes fits; noted at info.
 * - `nullable`: the live column is NULLABLE where NOT NULL is declared — the build writes values
 *   and never a null; noted at info.
 * - `not-null`: the live column is NOT NULL where NULLABLE is declared — a null the build writes
 *   fails at that write, a runtime fact for the operator, never a boot failure; noted at warn.
 */
export type ToleratedColumnDifference =
  | { name: string; difference: 'wider-type'; declaredType: string; physicalType: string }
  | { name: string; difference: 'nullable' }
  | { name: string; difference: 'not-null' };

export interface TableChanges {
  columnsToCreate: string[];
  columnsToRename: string[];
  columnsToAlter: string[];
  columnTypeChanges: ColumnTypeChange[];
  /** Never a change: what the sync leaves as it stands, for the operator's eyes. */
  toleratedColumnDifferences: ToleratedColumnDifference[];
  columnsWithForeignKeysToCreate: string[];
  foreignKeysToCreate: ForeignKey[];
  columnsWithForeignKeysToDrop: string[];
  foreignKeysToDrop: ForeignKey[];
  columnsWithUniqueConstraintsToCreate: string[];
  columnsWithUniqueConstraintsToDrop: string[];
  indexesToCreate: Index[];
  indexesToDrop: Index[];
}
