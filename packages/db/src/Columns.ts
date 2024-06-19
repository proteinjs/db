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

    const ids = (await fieldValue.get()).map((record) => record.id);
    return await super.serialize(ids as any);
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
