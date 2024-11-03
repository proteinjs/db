import moment from 'moment';
import { v1 as uuidv1 } from 'uuid';
import { Column, ColumnOptions, getColumnPropertyName, Table, tableByName } from './Table';
import { Record } from './Record';
import { ReferenceArray } from './reference/ReferenceArray';
import { Db } from './Db';
import { Reference } from './reference/Reference';
import { QueryBuilderFactory } from './QueryBuilderFactory';

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
    this.options = Object.assign(
      {
        ui: {
          hidden: maxLength === 'MAX',
        },
      },
      options
    );
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

  async deserialize(serializedFieldValue: boolean | null): Promise<boolean | null> {
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

  async deserialize(serializedFieldValue: Date | null): Promise<moment.Moment | null> {
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
    ); // MAX is 4gb
  }

  async serialize(fieldValue: T | null | undefined): Promise<string | null> {
    if (fieldValue === undefined || fieldValue == null) {
      return null;
    }

    return JSON.stringify(fieldValue);
  }

  async deserialize(serializedFieldValue: string): Promise<T | null> {
    if (serializedFieldValue === undefined || serializedFieldValue == null) {
      return null;
    }

    return JSON.parse(serializedFieldValue);
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
  constructor(
    name: string,
    public referenceTable: string,
    public cascadeDelete: boolean,
    options?: ColumnOptions
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
      )
    );
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

  async deserialize(serializedFieldValue: string): Promise<ReferenceArray<T> | null> {
    let ids = (await super.deserialize(serializedFieldValue)) as string[] | null;
    if (ids === null) {
      ids = [];
    }

    return new ReferenceArray(this.referenceTable, ids);
  }

  async beforeDelete(table: Table<any>, columnPropertyName: string, records: any[]) {
    if (!this.cascadeDelete) {
      return;
    }

    const recordIdsToDelete: string[] = [];
    for (const record of records) {
      const referenceArray = record[columnPropertyName] as ReferenceArray<Record>;
      const referenceRecords = await referenceArray.get();
      for (const referenceRecord of referenceRecords) {
        recordIdsToDelete.push(referenceRecord.id);
      }
    }

    if (recordIdsToDelete.length < 1) {
      return;
    }

    const referenceTable = tableByName(this.referenceTable);
    const qb = new QueryBuilderFactory()
      .getQueryBuilder(referenceTable)
      .condition({ field: 'id', operator: 'IN', value: recordIdsToDelete });
    await new Db().delete(referenceTable, qb);
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
  constructor(
    name: string,
    public referenceTable: string,
    public cascadeDelete: boolean,
    options?: ColumnOptions
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
      36
    );
  }

  async serialize(fieldValue: Reference<T> | null | undefined): Promise<string | null> {
    if (fieldValue === undefined || fieldValue == null || !fieldValue._id) {
      return null;
    }

    return fieldValue._id;
  }

  async deserialize(serializedFieldValue: string): Promise<Reference<T> | null> {
    const reference = new Reference(this.referenceTable, serializedFieldValue);
    if (reference._id === null) {
      return null;
    }

    return reference as Reference<T>;
  }

  async beforeDelete(table: Table<any>, columnPropertyName: string, records: any[]) {
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

    const referenceTable = tableByName(this.referenceTable);
    const qb = new QueryBuilderFactory()
      .getQueryBuilder(referenceTable)
      .condition({ field: 'id', operator: 'IN', value: recordIdsToDelete });
    await new Db().delete(referenceTable, qb);
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

// veronica todo: make sure we check the presence of both columns needed at table creation in table manager
export class DynamicReferenceColumn<T extends Record> extends StringColumn<Reference<T>> {
  constructor(
    name: string,
    public dynamicRefTableColName: string,
    public cascadeDelete: boolean = false,
    options?: ColumnOptions
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
      36
    );
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

  async deserialize(serializedFieldValue: string, serializedRecord: any): Promise<Reference<T> | null> {
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

    const getTableFn = getTable ? getTable : tableByName;
    const dbInstance = db ? db : new Db();

    // Get all referenced record IDs grouped by table
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

    // Delete records from each referenced table using Promise.all to properly await all deletions
    const entries = Array.from(recordsToDelete.entries());
    console.log(`entries to delete: ${JSON.stringify(entries)}`);
    for (const [tableName, ids] of entries) {
      if (ids.length > 0) {
        const referenceTable = getTableFn(tableName);
        const qb = new QueryBuilderFactory()
          .getQueryBuilder(referenceTable)
          .condition({ field: 'id', operator: 'IN', value: ids });
        await dbInstance.delete(referenceTable, qb);
      }
    }
  }
}
