import { Logger } from '@proteinjs/logger';
import { DateTimeColumn, UuidColumn } from './Columns';
import { Column, Table, Columns } from './Table';
import { moment } from './opt/moment';

export interface Record {
  id: string;
  created: moment.Moment;
  updated: moment.Moment;
}

const recordColumns: Columns<Record> = {
  id: new UuidColumn('id', { ui: { hidden: true } }),
  created: new DateTimeColumn('created', {
    defaultValue: async () => moment(),
  }),
  updated: new DateTimeColumn('updated', {
    defaultValue: async () => moment(),
    updateValue: async () => moment(),
  }),
};

class MissingFieldError extends Error {
  constructor(tableName: string, fieldName: string) {
    super(`Table ${tableName} is missing field: ${fieldName}`);
    this.name = 'MissingFieldError';
  }
}

/**
 * Wrapper function to add default Record columns to your table's columns (should always use).
 *
 * Note: using this requires an explicit dependency on moment@2.29.4 in your package (since transient dependencies are brittle by typescript's standards)
 *
 * @param columns your columns
 * @returns recordColumns & your columns
 */
export function withRecordColumns<T extends Record>(
  columns: Columns<Omit<T, keyof Record>>
): Columns<Record> & Columns<Omit<T, keyof Record>> {
  return Object.assign(Object.assign({}, recordColumns), columns);
}

export type SerializedRecord = { [columnName: string]: any };

export class RecordSerializer<T extends Record> {
  private logger = new Logger({ name: this.constructor.name });
  private table: Table<T>;

  constructor(table: Table<T>) {
    this.table = table;
  }

  async serialize(record: any): Promise<SerializedRecord> {
    const serialized: any = {};
    const fieldSerializer = new FieldSerializer(this.table);
    const omittedFields: string[] = [];
    for (const fieldPropertyName in record) {
      if (typeof record[fieldPropertyName] === 'function') {
        continue;
      }

      const fieldValue = await record[fieldPropertyName];
      if (fieldValue === undefined) {
        throw new Error(`Must not pass in undefined. Undefined was found for field: ${fieldPropertyName}`);
      }
      try {
        const { columnName, serializedFieldValue } = await fieldSerializer.serialize(fieldPropertyName, fieldValue);
        serialized[columnName] = serializedFieldValue;
      } catch (MissingFieldError) {
        omittedFields.push(fieldPropertyName);
      }
    }

    if (omittedFields.length > 0) {
      // could mean the developer is passing in an object they don't expect
      this.logger.warn({ message: `Fields were omitted during serialization`, obj: { omittedFields } });
    }

    return serialized;
  }

  async deserialize(serializedRecord: SerializedRecord): Promise<T> {
    const deserialized: any = {};
    const fieldSerializer = new FieldSerializer(this.table);
    const omittedFields: string[] = [];
    for (const columnName in serializedRecord) {
      const serializedFieldValue = serializedRecord[columnName];
      try {
        const { fieldPropertyName, fieldValue } = await fieldSerializer.deserialize(
          columnName,
          serializedFieldValue,
          serializedRecord
        );
        deserialized[fieldPropertyName] = fieldValue;
      } catch (MissingFieldError) {
        omittedFields.push(columnName);
      }
    }

    if (omittedFields.length > 0) {
      // expected when passing a base table into the query api
      this.logger.debug({ message: `Fields were omitted during deserialization`, obj: { omittedFields } });
    }

    return deserialized;
  }
}

export class FieldSerializer<T extends Record> {
  constructor(private table: Table<T>) {}

  async serialize(fieldPropertyName: string, fieldValue: any) {
    const columns: { [prop: string]: Column<any, any> } = this.table.columns;
    const column = columns[fieldPropertyName];
    if (!column) {
      throw new MissingFieldError(this.table.name, fieldPropertyName);
    }

    let serializedFieldValue = fieldValue;
    if (column.serialize) {
      serializedFieldValue = await column.serialize(fieldValue);
    }

    return { columnName: column.name, serializedFieldValue };
  }

  async deserialize(columnName: string, serializedFieldValue: any, serializedRecord: SerializedRecord) {
    const columns: { [prop: string]: Column<any, any> } = this.table.columns;
    let fieldPropertyName = columnName;
    let column = columns[columnName]; // the scenario that the column name is the same as the property name
    if (!column) {
      for (const columnPropertyName in columns) {
        const checkColumn = (this.table.columns as any)[columnPropertyName];
        if (checkColumn && columnName == checkColumn.name) {
          fieldPropertyName = columnPropertyName;
          column = checkColumn;
          break;
        }
      }
    }

    if (!column) {
      // this is the case where a column exists in the db that is no longer defined in Table.columns
      throw new MissingFieldError(this.table.name, fieldPropertyName);
    }

    let fieldValue = serializedFieldValue;
    if (column.deserialize) {
      fieldValue = await column.deserialize(serializedFieldValue, serializedRecord);
    }

    return { fieldPropertyName, fieldValue };
  }
}
