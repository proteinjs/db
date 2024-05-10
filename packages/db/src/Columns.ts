import moment from 'moment';
import { v1 as uuidv1 } from 'uuid';
import { Column, ColumnOptions, Table, tableByName } from './Table';
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

export class BooleanColumn implements Column<boolean, boolean> {
  constructor(
    public name: string,
    public options?: ColumnOptions
  ) {}

  async serialize(fieldValue: boolean | undefined): Promise<boolean> {
    if (fieldValue) {
      return true;
    }

    return false;
  }

  async deserialize(serializedFieldValue: boolean): Promise<boolean> {
    if (serializedFieldValue) {
      return true;
    }

    return false;
  }
}

export class DateColumn implements Column<Date, Date> {
  constructor(
    public name: string,
    public options?: ColumnOptions
  ) {}
}

export class DateTimeColumn implements Column<moment.Moment, Date> {
  constructor(
    public name: string,
    public options?: ColumnOptions
  ) {}

  async serialize(fieldValue: moment.Moment | undefined): Promise<Date | undefined> {
    if (typeof fieldValue === 'undefined') {
      return;
    }

    if (typeof fieldValue.toDate === 'undefined') {
      return moment(fieldValue).toDate();
    }

    return fieldValue.toDate();
  }

  async deserialize(serializedFieldValue: Date): Promise<moment.Moment> {
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

  async serialize(fieldValue: T | undefined): Promise<string | undefined> {
    if (typeof fieldValue === 'undefined' || fieldValue == null) {
      return;
    }

    return JSON.stringify(fieldValue);
  }

  async deserialize(serializedFieldValue: string): Promise<T | undefined> {
    if (typeof serializedFieldValue === 'undefined' || serializedFieldValue == null) {
      return;
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

  async serialize(fieldValue: ReferenceArray<T> | undefined): Promise<string | undefined> {
    if (typeof fieldValue === 'undefined') {
      return;
    }

    const ids = (await fieldValue.get()).map((record) => record.id);
    return await super.serialize(ids as any);
  }

  async deserialize(serializedFieldValue: string): Promise<ReferenceArray<T>> {
    let ids = (await super.deserialize(serializedFieldValue)) as string[] | undefined;
    if (typeof ids === 'undefined') {
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

  async serialize(fieldValue: Reference<T> | undefined): Promise<string | undefined> {
    if (typeof fieldValue === 'undefined') {
      return;
    }

    if (!fieldValue._id) {
      return;
    }

    return fieldValue._id;
  }

  async deserialize(serializedFieldValue: string): Promise<Reference<T>> {
    return new Reference(this.referenceTable, serializedFieldValue);
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
