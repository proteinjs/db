import moment from 'moment';
import { v1 as uuidv1 } from 'uuid';
import { Column, ColumnOptions, getColumnPropertyName, Table } from './Table';
import { Record } from './Record';
import { ReferenceArray } from './reference/ReferenceArray';
import { Db } from './Db';
import { Reference } from './reference/Reference';
import { QueryBuilderFactory } from './QueryBuilderFactory';
import { Serializer } from '@proteinjs/serializer';

export interface ReferenceColumnOptions extends ColumnOptions {
  /** If true, when a record in the referenced table is deleted, this record is deleted */
  reverseCascadeDelete?: boolean;
}

export class IntegerColumn implements Column<number, number> {
  constructor(
    public name: string,
    public options?: ColumnOptions,
    public large = false
  ) {}
}

export class StringColumn<T = string> implements Column<T, string> {
  constructor(
    public name: string,
    public options?: ColumnOptions,
    public maxLength: number | 'MAX' = 255
  ) {
    /**
     * Unbounded ('MAX') text columns are NOT default-hidden (founder ruling, admin round 3):
     * the record FORM renders any length safely now (multiline field with the bounded preview
     * + expand dialog past the inline bound), and a value like a migration's failure stack is
     * exactly what the form gets opened to read. The record TABLE's default column pick still
     * excludes unbounded text (a row can't afford one) — that exclusion lives with the pick
     * (db-ui `defaultRecordTableColumns`), keyed on `maxLength`, not here. `ui.hidden` remains
     * the author's explicit hide-everywhere; subclasses whose storage happens to be MAX but
     * whose values aren't prose (Object/Array/Password/Uuid) declare their own ui defaults.
     */
    this.options = Object.assign({ ui: {} }, options);
  }
}

export class FloatColumn implements Column<number, number> {
  constructor(
    public name: string,
    public options?: ColumnOptions
  ) {}
}

export class DecimalColumn implements Column<number, number> {
  constructor(
    public name: string,
    public options?: ColumnOptions,
    public large = false
  ) {}
}

export class BooleanColumn implements Column<boolean | null, boolean | null> {
  constructor(
    public name: string,
    public options?: ColumnOptions
  ) {}

  async serialize(fieldValue: boolean | null | undefined): Promise<boolean | null> {
    if (fieldValue) {
      return true;
    }

    if (fieldValue === false) {
      return false;
    }

    return null;
  }

  deserialize(serializedFieldValue: boolean | null): boolean | null {
    if (serializedFieldValue) {
      return true;
    }

    if (serializedFieldValue === false) {
      return false;
    }

    return null;
  }
}

export class DateColumn implements Column<Date, Date> {
  constructor(
    public name: string,
    public options?: ColumnOptions
  ) {}
}

export class DateTimeColumn implements Column<moment.Moment | null, Date | null> {
  /**
   * The moment is built on the field's first read, not at hydration (`Column.deserializeOnFirstRead`):
   * a row carries several of these and most are never read, and a moment costs more to build than
   * the stored Date it is built from.
   */
  readonly deserializeOnFirstRead = true;

  constructor(
    public name: string,
    public options?: ColumnOptions
  ) {}

  async serialize(fieldValue: moment.Moment | undefined | null): Promise<Date | null> {
    if (fieldValue === undefined || fieldValue === null || !moment.isMoment(fieldValue)) {
      return null;
    }

    if (typeof fieldValue.toDate === 'undefined') {
      return moment(fieldValue).toDate();
    }

    return fieldValue.toDate();
  }

  deserialize(serializedFieldValue: Date | null): moment.Moment | null {
    if (serializedFieldValue === undefined || serializedFieldValue === null) {
      return null;
    }

    return moment(serializedFieldValue);
  }
}

export class BinaryColumn implements Column<number, number> {
  constructor(
    public name: string,
    public options?: ColumnOptions,
    public maxLength?: number | 'MAX'
  ) {
    this.options = Object.assign(
      {
        ui: {
          hidden: true,
        },
      },
      options
    );
  }
}

export class UuidColumn extends StringColumn {
  constructor(name: string, options?: ColumnOptions) {
    super(
      name,
      Object.assign(
        {
          defaultValue: async () => uuidv1(),
          ui: {
            hidden: true,
          },
        },
        options
      ),
      36
    );
  }
}

export class PasswordColumn extends StringColumn {
  constructor(name: string, options?: ColumnOptions) {
    super(name, Object.assign({ ui: { hidden: true } }, options));
  }
}

export class ObjectColumn<T> extends StringColumn<T> {
  constructor(name: string, options?: ColumnOptions) {
    super(
      name,
      Object.assign(
        {
          ui: {
            hidden: true,
          },
        },
        options
      ),
      'MAX'
    );
  }

  async serialize(fieldValue: T | null | undefined): Promise<string | null> {
    if (fieldValue === undefined || fieldValue == null) {
      return null;
    }

    return Serializer.serialize(fieldValue);
  }

  deserialize(serializedFieldValue: string): T | null {
    if (serializedFieldValue === undefined || serializedFieldValue == null) {
      return null;
    }

    return Serializer.deserialize(serializedFieldValue);
  }
}

export class ArrayColumn<T> extends ObjectColumn<T[]> {
  constructor(name: string, options?: ColumnOptions) {
    super(
      name,
      Object.assign(
        {
          ui: {
            hidden: true,
          },
        },
        options
      )
    );
  }
}

export class ReferenceArrayColumn<T extends Record> extends ObjectColumn<ReferenceArray<T>> {
  /**
   * A column that stores an array of references to other records.
   *
   * @param name name of column
   * @param referenceTable name of table that the reference records are in
   * @param cascadeDelete if true referenced records will be deleted when this record is deleted
   * @param options generic column options
   */
  public reverseCascadeDelete: boolean;

  constructor(
    name: string,
    public referenceTable: string,
    public cascadeDelete: boolean,
    options?: ReferenceColumnOptions
  ) {
    super(name, options);
    this.reverseCascadeDelete = !!options?.reverseCascadeDelete;
  }

  async serialize(fieldValue: ReferenceArray<T> | null | undefined): Promise<string | null> {
    if (fieldValue === undefined || fieldValue == null) {
      return null;
    }

    let returnIds = fieldValue._ids;

    // ids and objects are not in sync, if objects exists then it is the most up to date data
    if (fieldValue._objects) {
      returnIds = fieldValue._objects.map((record) => record.id);
    }

    return await super.serialize(returnIds as any);
  }

  deserialize(serializedFieldValue: string): ReferenceArray<T> | null {
    let ids = super.deserialize(serializedFieldValue) as string[] | null;
    if (ids === null) {
      ids = [];
    }

    return new ReferenceArray(this.referenceTable, ids);
  }

  /**
   * Cascade: the referenced records go with the holder. Runs through the Db the firing write
   * hands it — its driver, its transaction context, its authority — and off the ids the column
   * stores; nothing here opens a Db of its own or re-reads the referenced rows, either of which
   * would run as the session's user rather than as the write (a system delete's cascade must stay
   * system: in a background context there is no session user at all).
   */
  async beforeDelete(
    table: Table<any>,
    columnPropertyName: string,
    records: any[],
    getTable?: (tableName: string) => Table<any>,
    db?: Db
  ): Promise<void> {
    if (!this.cascadeDelete) {
      return;
    }

    const recordIdsToDelete: string[] = [];
    for (const record of records) {
      const referenceArray = record[columnPropertyName] as ReferenceArray<Record> | null | undefined;
      if (referenceArray) {
        recordIdsToDelete.push(...referenceArray._ids);
      }
    }

    if (recordIdsToDelete.length < 1) {
      return;
    }

    // Optional in the hook contract for implementers that need neither; the Db hands both to every hook.
    const referenceTable = getTable!(this.referenceTable);
    const qb = new QueryBuilderFactory()
      .getQueryBuilder(referenceTable)
      .condition({ field: 'id', operator: 'IN', value: recordIdsToDelete });
    await db!.delete(referenceTable, qb);
  }
}

export class ReferenceColumn<T extends Record> extends StringColumn<Reference<T>> {
  /**
   * A column that stores a reference (id) to another record.
   *
   * @param name name of column
   * @param referenceTable name of table that the reference record is in
   * @param cascadeDelete if true referenced record will be deleted when this record is deleted
   * @param options generic column options
   */
  public reverseCascadeDelete: boolean;

  constructor(
    name: string,
    public referenceTable: string,
    public cascadeDelete: boolean,
    options?: ReferenceColumnOptions & {
      /** Id-column width (default 36, uuid). Pass the EXISTING width when adopting a column
       *  that predates the reference type — Spanner cannot narrow a STRING in place. */
      maxLength?: number;
    }
  ) {
    super(name, options, options?.maxLength ?? 36);
    this.reverseCascadeDelete = !!options?.reverseCascadeDelete;
  }

  async serialize(fieldValue: Reference<T> | null | undefined): Promise<string | null> {
    if (fieldValue === undefined || fieldValue == null || !fieldValue._id) {
      return null;
    }

    return fieldValue._id;
  }

  deserialize(serializedFieldValue: string): Reference<T> | null {
    const reference = new Reference(this.referenceTable, serializedFieldValue);
    if (reference._id === null) {
      return null;
    }

    return reference as Reference<T>;
  }

  /**
   * Cascade: the referenced record goes with the holder. Runs through the Db the firing write
   * hands it (its driver, transaction context and authority) off the stored id — see
   * `ReferenceArrayColumn.beforeDelete` for why the hook never opens a Db of its own.
   */
  async beforeDelete(
    table: Table<any>,
    columnPropertyName: string,
    records: any[],
    getTable?: (tableName: string) => Table<any>,
    db?: Db
  ): Promise<void> {
    if (!this.cascadeDelete) {
      return;
    }

    const recordIdsToDelete: string[] = [];
    for (const record of records) {
      const reference = record[columnPropertyName] as Reference<Record>;
      if (reference && reference._id) {
        recordIdsToDelete.push(reference._id);
      }
    }

    if (recordIdsToDelete.length < 1) {
      return;
    }

    // Optional in the hook contract for implementers that need neither; the Db hands both to every hook.
    const referenceTable = getTable!(this.referenceTable);
    const qb = new QueryBuilderFactory()
      .getQueryBuilder(referenceTable)
      .condition({ field: 'id', operator: 'IN', value: recordIdsToDelete });
    await db!.delete(referenceTable, qb);
  }
}

/** Column type for storing table names that links to a DynamicReferenceColumn */
export class DynamicReferenceTableNameColumn extends StringColumn<string> {
  constructor(
    name: string,
    public referenceColumnName: string,
    options?: ColumnOptions
  ) {
    const enhancedOptions = {
      ...options,
      defaultValue: async (table: Table<any>, record: any) => {
        const colPropertyName = getColumnPropertyName(table, name);
        const refColPropertyName = getColumnPropertyName(table, referenceColumnName);
        if (!colPropertyName) {
          throw new Error(`Column ${name} in table ${table.name} not found when setting default value`);
        }
        if (!refColPropertyName) {
          throw new Error(`Column ${referenceColumnName} in table ${table.name} not found when setting default value`);
        }

        // No reference is being set, so we can return early
        if (!record[refColPropertyName]) {
          return options?.defaultValue ? await options.defaultValue(table, record) : record[colPropertyName] ?? null;
        }

        // Get the table name from the reference column
        const { _table: referenceTableName } = record[refColPropertyName];

        if (!referenceTableName) {
          throw new Error(
            `When inserting, table name must be set in Reference object for DynamicReferenceColumn ${referenceColumnName}`
          );
        }

        // Assign the table name and return it, unless an defaultValue function is provided via options
        record[colPropertyName] = referenceTableName;
        return options?.defaultValue ? await options.defaultValue(table, record) : referenceTableName;
      },
      updateValue: async (table: Table<any>, updateObj: any) => {
        const colPropertyName = getColumnPropertyName(table, name);
        const refColPropertyName = getColumnPropertyName(table, referenceColumnName);
        if (!colPropertyName) {
          throw new Error(`Column ${name} in table ${table.name} not found when setting default value`);
        }
        if (!refColPropertyName) {
          throw new Error(`Column ${referenceColumnName} in table ${table.name} not found when setting default value`);
        }

        // The reference column is not being updated, so we can return early
        if (!updateObj[refColPropertyName]) {
          return options?.updateValue?.(table, updateObj) ?? updateObj[colPropertyName] ?? undefined;
        }

        // Get the table name from the new reference column
        const { _table: newTableName } = updateObj[refColPropertyName];

        if (!newTableName) {
          throw new Error(
            `When inserting, table name must be set in Reference object for DynamicReferenceColumn ${referenceColumnName}`
          );
        }

        // Assign the new table name and return it, unless an updateValue function is provided via options
        updateObj[colPropertyName] = newTableName;
        return options?.updateValue?.(table, updateObj) ?? newTableName;
      },
    };

    super(
      name,
      Object.assign(
        {
          ui: {
            hidden: true,
          },
        },
        enhancedOptions
      )
    );
  }
}

/**
 * Creates a dynamic reference column that can link to records in any table
 *
 * The reference is stored as two columns:
 * 1. A `DynamicReferenceTableNameColumn` storing the reference's table name, which is managed internally and should not be set or updated
 * 2. A `DynamicReferenceColumn` which is a reference to a record
 *
 * @example
 * {
 *   referenceTableName: new DynamicReferenceTableNameColumn('reference_table_name', 'dynamic_reference'),
 *   dynamicReference: new DynamicReferenceColumn<EntityType>(
 *     'dynamic_reference',
 *     'reference_table_name',    // Name of column containing table name
 *   )
 * }
 */

export class DynamicReferenceColumn<T extends Record> extends StringColumn<Reference<T>> {
  public reverseCascadeDelete: boolean;

  constructor(
    name: string,
    public dynamicRefTableColName: string,
    public cascadeDelete: boolean = false,
    options?: ReferenceColumnOptions & {
      /** Id-column width (default 36, uuid). Pass the EXISTING width when adopting a column
       *  that predates the dynamic reference — Spanner cannot narrow a STRING in place. */
      maxLength?: number;
    }
  ) {
    super(
      name,
      Object.assign(
        {
          ui: {
            hidden: true,
          },
        },
        options
      ),
      options?.maxLength ?? 36
    );
    this.reverseCascadeDelete = !!options?.reverseCascadeDelete;
  }

  async serialize(fieldValue: Reference<T> | null | undefined): Promise<string | null> {
    if (fieldValue === undefined || fieldValue == null || !fieldValue._id) {
      return null;
    }

    if (!fieldValue._table || fieldValue._table.trim() === '') {
      throw new Error(`Table name must be provided for DynamicReferenceColumn ${this.name}`);
    }

    return fieldValue._id;
  }

  deserialize(serializedFieldValue: string, serializedRecord: any): Reference<T> | null {
    const reference = new Reference('', serializedFieldValue);
    if (reference._id === null) {
      return null;
    }

    const tableName = serializedRecord[this.dynamicRefTableColName];
    if (!tableName) {
      throw new Error(`Table name not found in column ${this.dynamicRefTableColName} for reference ${this.name}`);
    }

    return new Reference<T>(tableName, serializedFieldValue);
  }

  /**
   * Cascade: the referenced record goes with the holder, whichever table the row names. Runs
   * through the Db the firing write hands it (its driver, transaction context and authority) off
   * the stored ids — see `ReferenceArrayColumn.beforeDelete` for why the hook never opens a Db of
   * its own.
   */
  async beforeDelete(
    table: Table<any>,
    columnPropertyName: string,
    records: any[],
    getTable?: (tableName: string) => Table<any>,
    db?: Db
  ): Promise<void> {
    if (!this.cascadeDelete) {
      return;
    }

    // The referenced ids, grouped by the table each row names
    const recordsToDelete = new Map<string, string[]>();
    for (const record of records) {
      const reference = record[columnPropertyName] as Reference<Record>;
      if (!reference?._id || !reference._table) {
        continue;
      }

      if (!recordsToDelete.has(reference._table)) {
        recordsToDelete.set(reference._table, []);
      }
      recordsToDelete.get(reference._table)!.push(reference._id);
    }

    // Optional in the hook contract for implementers that need neither; the Db hands both to every hook.
    for (const [tableName, ids] of Array.from(recordsToDelete.entries())) {
      const referenceTable = getTable!(tableName);
      const qb = new QueryBuilderFactory()
        .getQueryBuilder(referenceTable)
        .condition({ field: 'id', operator: 'IN', value: ids });
      await db!.delete(referenceTable, qb);
    }
  }
}
