import { Logger } from '@proteinjs/logger';
import { Column, Table, getTables } from '../Table';
import { SchemaOperations, TableChanges } from './SchemaOperations';
import { SchemaMetadata } from './SchemaMetadata';
import { DbDriver } from '../Db';
import { DynamicReferenceColumn, DynamicReferenceTableNameColumn } from '../Columns';

const getEnvVar = (key: string): string | undefined =>
  typeof process !== 'undefined' && process.env ? process.env[key] : undefined;

export interface ColumnTypeFactory {
  getType(column: Column<any, any>): string;
}

export class TableManager {
  /**
   * Bounded verification re-reads for {@link reconcileConcurrentSchemaChange}: an already-exists
   * DDL error proves the conflicting schema change COMMITTED, but INFORMATION_SCHEMA on this
   * connection can briefly lag that commit — 5 × 200ms rides out the propagation without letting
   * a genuine conflict stall for more than ~1s.
   */
  private static readonly RECONCILE_VERIFY_ATTEMPTS = 5;
  private static readonly RECONCILE_VERIFY_RETRY_DELAY_MS = 200;
  private logger = new Logger({ name: this.constructor.name, logLevel: getEnvVar('DB_LOG_LEVEL') as any });
  public columnTypeFactory: ColumnTypeFactory;
  public schemaOperations: SchemaOperations;
  public schemaMetadata: SchemaMetadata;

  constructor(
    dbDriver: DbDriver,
    columnTypeFactory: ColumnTypeFactory,
    schemaOperations: SchemaOperations,
    schemaMetadata?: SchemaMetadata
  ) {
    this.columnTypeFactory = columnTypeFactory;
    this.schemaOperations = schemaOperations;
    this.schemaMetadata = schemaMetadata ? schemaMetadata : new SchemaMetadata(dbDriver);
  }

  async tableExists(table: Table<any>) {
    return await this.schemaMetadata.tableExists(table);
  }

  /**
   * Reconcile every registered table with the live schema. Absent tables are created as ONE
   * batch (a single schema-update operation on drivers that support it — the prod-boot win),
   * preserving their registration order so foreign keys to other absent tables resolve; existing
   * tables are altered individually after, so an alter that adds a foreign key to a
   * just-created table sees it live.
   */
  async loadTables(): Promise<void> {
    const tables = getTables();
    const absentTables: Table<any>[] = [];
    const existingTables: Table<any>[] = [];
    for (const table of tables) {
      this.validateDynamicReferenceColumns(table);
      if (await this.tableExists(table)) {
        existingTables.push(table);
      } else {
        absentTables.push(table);
      }
    }

    if (absentTables.length > 0) {
      this.logger.info({ message: `Creating tables: ${absentTables.map((table) => table.name).join(', ')}` });
      try {
        await this.schemaOperations.createTables(absentTables);
      } catch (error) {
        await this.reconcileConcurrentSchemaChange(absentTables, error);
      }
      this.logger.info({ message: `Finished creating ${absentTables.length} tables` });
    }

    for (const table of existingTables) {
      await this.alterTableIfChanged(table);
    }
  }

  async loadTable(table: Table<any>): Promise<void> {
    this.validateDynamicReferenceColumns(table);

    if (await this.tableExists(table)) {
      await this.alterTableIfChanged(table);
    } else {
      this.logger.info({ message: `Creating table: ${table.name}` });
      try {
        await this.schemaOperations.createTables([table]);
      } catch (error) {
        await this.reconcileConcurrentSchemaChange([table], error);
      }
      this.logger.info({ message: `Finished creating table: ${table.name}` });
    }
  }

  private async alterTableIfChanged(table: Table<any>): Promise<void> {
    const tableChanges = await this.getTableChanges(table);
    if (this.shouldAlterTable(tableChanges)) {
      this.logger.info({ message: `Altering table: ${table.name}` });
      try {
        await this.schemaOperations.alterTable(table, tableChanges);
      } catch (error) {
        await this.reconcileConcurrentSchemaChange([table], error);
      }
      this.logger.info({ message: `Finished altering table: ${table.name}` });
    }
  }

  /**
   * Reconcile a create/alter DDL failure against a concurrent schema change, closing the
   * check-then-act race in loadTable/loadTables.
   *
   * On a schema-changing release the migration Job, booting pods, and multiple replicas all run
   * Db.init -> loadTables at once. Reconcile is check-then-act (read INFORMATION_SCHEMA -> decide
   * create/alter -> apply DDL): two actors can both observe the same column/table as absent and
   * both issue the CREATE/ALTER. The backend serializes DDL so the object lands EXACTLY once, but
   * the loser's operation fails with an already-exists / duplicate-name error. Before this
   * reconcile that error propagated out of Db.init — a booting pod with no unhandledRejection
   * handler exited (CrashLoopBackOff) and the migration Job exited 1 (a spurious migration-gate
   * failure).
   *
   * This is NOT a blanket swallow (that would mask real schema failures). Two independent gates
   * must BOTH pass before a failure is treated as success:
   *  1. CLASS — the driver's schema layer, which owns the backend's error codes/messages, must
   *     classify the error as the already-exists class ({@link SchemaOperations.isAlreadyExistsError}).
   *     A driver that does not implement the classifier always rethrows here.
   *  2. INTENDED DEFINITION — a re-read of the live schema (the same metadata-backed detection
   *     getTableChanges uses) must confirm every table now exists AND has no remaining changes of
   *     the kind we attempted. A concurrent actor applying our EXACT change satisfies this; a
   *     genuine conflict (e.g. the column landed with a different type, so a column-type change is
   *     still outstanding) does not. The re-read is resilient to brief schema propagation — see
   *     {@link verifyIntendedDefinition} for the bounded retry that prevents a momentarily-stale
   *     INFORMATION_SCHEMA read from false-negativing into the very crash this closes.
   * If either gate fails, the ORIGINAL error propagates unchanged. Because every actor runs this
   * same reconcile, it closes all three windows: migration-Job-vs-pod, pod-vs-pod, and
   * multi-replica boot.
   *
   * OBSERVABILITY: this path is reached ONLY from the create/alter catch (the no-error happy path
   * never calls it). Every outcome that reaches the intended-definition gate is logged LOUDLY at
   * WARN — tolerance fired (treated as applied) OR the re-read failed (genuine conflict / still
   * absent, re-throwing) — so an unexpected activation is visible in prod logs rather than silent.
   */
  private async reconcileConcurrentSchemaChange(tables: Table<any>[], error: unknown): Promise<void> {
    if (!this.schemaOperations.isAlreadyExistsError?.(error)) {
      throw error;
    }

    const tableNames = tables.map((table) => table.name).join(', ');
    const reason = this.schemaErrorReason(error);

    for (const table of tables) {
      await this.verifyIntendedDefinition(table, tableNames, reason, error);
    }

    this.logger.warn({
      message: `[schema reconcile] tolerated concurrent ALREADY_EXISTS for table(s) '${tableNames}' — re-read verified the object present with the intended definition, treating as applied (a concurrent actor won the race). reason: ${reason}`,
    });
  }

  /**
   * Re-read the live schema until `table` is present with the intended definition, retrying a
   * BOUNDED number of times ({@link RECONCILE_VERIFY_ATTEMPTS} × {@link RECONCILE_VERIFY_RETRY_DELAY_MS}).
   *
   * The already-exists error means the conflicting DDL has COMMITTED — the object exists — but
   * INFORMATION_SCHEMA on this connection can briefly lag that commit, and a single point-in-time
   * read that misses it would false-negative into a re-throw, reintroducing the exact boot crash
   * this reconcile closes. So the re-read's job is (a) to wait out momentary invisibility and
   * (b) to verify the DEFINITION matches intent. A momentary stale read resolves via retry into
   * success; only a definition still absent or mismatched after every attempt is a genuine
   * conflict — logged at WARN, then the ORIGINAL error re-throws.
   */
  private async verifyIntendedDefinition(
    table: Table<any>,
    tableNames: string,
    reason: string,
    error: unknown
  ): Promise<void> {
    let remainingChanges: TableChanges | undefined;
    for (let attempt = 1; attempt <= TableManager.RECONCILE_VERIFY_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await this.delay(TableManager.RECONCILE_VERIFY_RETRY_DELAY_MS);
      }

      if (!(await this.tableExists(table))) {
        remainingChanges = undefined;
        continue;
      }

      remainingChanges = await this.getTableChanges(table);
      if (!this.shouldAlterTable(remainingChanges)) {
        return; // verified: present with the intended definition
      }
    }

    if (!remainingChanges) {
      // Still absent after every re-read — not the concurrent-winner case; surface the original
      // error rather than masking it.
      this.logger.warn({
        message: `[schema reconcile] caught ALREADY_EXISTS for table(s) '${tableNames}' but '${table.name}' is still absent after ${TableManager.RECONCILE_VERIFY_ATTEMPTS} re-reads — NOT a concurrent apply; re-throwing. reason: ${reason}`,
      });
      throw error;
    }

    // The object exists but the live schema still differs from the intended definition, so a
    // concurrent actor did NOT apply our exact change (a genuine conflict). Propagate.
    this.logger.warn({
      message: `[schema reconcile] caught ALREADY_EXISTS for table '${table.name}' but the live schema does NOT match the intended definition after ${TableManager.RECONCILE_VERIFY_ATTEMPTS} re-reads (genuine conflict) — re-throwing. reason: ${reason}`,
      obj: { remainingChanges },
    });
    throw error;
  }

  /** Concise, loggable reason from a schema-update error: the backend names the offending object
   *  in `details` (validation phase) or `message` (apply phase). */
  private schemaErrorReason(error: unknown): string {
    const candidate = error as { details?: unknown; message?: unknown } | undefined;
    return String(candidate?.details ?? candidate?.message ?? error);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private validateDynamicReferenceColumns(table: Table<any>): void {
    const isDynamicRefColumn = (column: any): column is DynamicReferenceColumn<any> =>
      typeof column.dynamicRefTableColName === 'string';

    const isDynamicRefTableNameColumn = (column: any): column is DynamicReferenceTableNameColumn =>
      typeof column.referenceColumnName === 'string';

    // Quick check if there are any dynamic reference columns
    const hasDynamicColumns = Object.values(table.columns).some(
      (column) => isDynamicRefColumn(column) || isDynamicRefTableNameColumn(column)
    );

    if (!hasDynamicColumns) {
      return;
    }

    interface DynamicRefColumnInfo {
      columnName: string;
      tableColumnName: string;
    }

    const dynamicRefColumns: DynamicRefColumnInfo[] = [];
    const dynamicRefTableNameColumns = new Set<string>();

    // collect both dynamic reference columns and table name columns
    Object.entries(table.columns).forEach(([_, column]) => {
      if (isDynamicRefColumn(column)) {
        dynamicRefColumns.push({
          columnName: column.name,
          tableColumnName: column.dynamicRefTableColName,
        });
      } else if (isDynamicRefTableNameColumn(column)) {
        dynamicRefTableNameColumns.add(column.name);
      }
    });

    // Validate references and mark used table names
    dynamicRefColumns.forEach(({ columnName, tableColumnName }) => {
      if (!dynamicRefTableNameColumns.has(tableColumnName)) {
        throw new Error(
          `Table ${table.name} has a DynamicReferenceColumn '${columnName}' but is missing its required DynamicReferenceTableNameColumn '${tableColumnName}'`
        );
      }
      // Mark this table name column as used by removing it from the set
      dynamicRefTableNameColumns.delete(tableColumnName);
    });

    // Any remaining table name columns are unused
    if (dynamicRefTableNameColumns.size > 0) {
      const unusedColumn = dynamicRefTableNameColumns.values().next().value;
      throw new Error(
        `Table ${table.name} has a DynamicReferenceTableNameColumn '${unusedColumn}' but no DynamicReferenceColumn references it`
      );
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
    ) {
      return false;
    }

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
          tableChanges.columnTypeChanges.push({ name: column.name, newType: columnType, oldType: existingColumnType });
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

        if (column.options?.unique?.unique === false && uniqueColumns.includes(column.name)) {
          // console.log(`column.options?.unique?.unique`)
          tableChanges.columnsWithUniqueConstraintsToDrop.push(column.name);
          alter = true;
        } else if (column.options?.unique?.unique && !uniqueColumns.includes(column.name)) {
          tableChanges.columnsWithUniqueConstraintsToCreate.push(column.name);
          alter = true;
        }

        if (
          (!column.options?.references && foreignKeys[column.name]) ||
          (column.options?.references &&
            foreignKeys[column.name] &&
            foreignKeys[column.name].referencedTableName != column.options.references.table)
        ) {
          // console.log(`column.options?.references`)
          tableChanges.columnsWithForeignKeysToDrop.push(column.name);
          tableChanges.foreignKeysToDrop.push({
            table: foreignKeys[column.name].referencedTableName,
            column: foreignKeys[column.name].referencedColumnName,
            referencedByColumn: column.name,
          });
          alter = true;
        } else if (column.options?.references && !foreignKeys[column.name]) {
          tableChanges.columnsWithForeignKeysToCreate.push(column.name);
          tableChanges.foreignKeysToCreate.push({
            table: column.options.references.table,
            column: 'id',
            referencedByColumn: column.name,
          });
          alter = true;
        }

        if (alter) {
          tableChanges.columnsToAlter.push(columnPropertyName);
        }

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
      columns: string | string[];
      unique?: boolean;
    }[] = [];
    const indexesToCreate: {
      name?: string;
      columns: string | string[];
      unique?: boolean;
    }[] = [];
    const currentIndexMap: { [serializedColumns: string]: boolean } = {};
    const existingIndexMap: { [serializedColumns: string]: boolean } = {};
    for (const keyName in existingIndexes) {
      existingIndexMap[JSON.stringify(existingIndexes[keyName])] = true;
    }

    if (table.indexes) {
      for (const index of table.indexes) {
        const columns = index.columns.map((x) => table.columns[x as string]!.name);
        const serializedColumns = JSON.stringify(columns);
        currentIndexMap[serializedColumns] = true;
        if (!existingIndexMap[serializedColumns]) {
          indexesToCreate.push({ name: index.name, columns, unique: index.unique });
        }
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
      ) {
        indexesToDrop.push({ name: keyName, columns: existingIndex });
      }
    }

    return { indexesToCreate, indexesToDrop };
  }
}
