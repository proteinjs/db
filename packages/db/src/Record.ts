import { Logger } from '@proteinjs/logger';
import { DateTimeColumn, UuidColumn } from './Columns';
import { Column, Table, Columns } from './Table';
import { moment } from './opt/moment';

export interface Record {
  id: string;
  created: moment.Moment;
  updated: moment.Moment;
}

export function isRecordColumn(column: string): column is keyof Record {
  return column === 'id' || column === 'created' || column === 'updated';
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

/**
 * Who a row being written belongs to — the data key its encrypted columns encrypt under (see
 * `EncryptionRecordHooks`) — plus the ROW the write describes, property-keyed: the record being
 * inserted, or (on an update) the stored row overlaid with the payload. Leaf policies resolve
 * from it (a thought's `type` decides which paths are words), so an `update({ id, object })`
 * that carries no `type` still lands under the row's own policy, never the default one.
 * `plaintext: true` is the decrypt-out walk: values pass the seam unencrypted (companions and
 * tokens cleared) regardless of the declaration — the rollback act runs on the live build.
 * Resolved by `Db` for writes touching encrypted columns.
 */
export type RecordEncryptionContext = { keyOwner: string; row?: any; plaintext?: boolean };

export class RecordSerializer<T extends Record> {
  private logger = new Logger({ name: this.constructor.name });
  private table: Table<T>;
  private encryptionContext?: RecordEncryptionContext;

  constructor(table: Table<T>, encryptionContext?: RecordEncryptionContext) {
    this.table = table;
    this.encryptionContext = encryptionContext;
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
        const undefinedFieldValueError = `Must not pass in undefined. Undefined was found for field: ${this.table.name}.${fieldPropertyName}`;
        throw new Error(undefinedFieldValueError);
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

    // The transparent encryption seam (`ColumnOptions.encrypted`): encrypted columns'
    // serialized values become ciphertext envelopes, search/sort companions are derived
    // beside them. Imported at call time — this module sits below the encryption machinery
    // in the package's module graph.
    const { EncryptionRecordHooks } = await import('./encryption/EncryptionRecordHooks');
    await new EncryptionRecordHooks().onSerialize(this.table, serialized, this.encryptionContext);
    return serialized;
  }

  async deserialize(serializedRecord: SerializedRecord): Promise<T> {
    // The transparent decryption seam: ciphertext envelopes decrypt (self-describing — the
    // envelope names its key), framework companion columns drop out of the result.
    const { EncryptionRecordHooks } = await import('./encryption/EncryptionRecordHooks');
    const prepared = await new EncryptionRecordHooks().onDeserialize(this.table, serializedRecord);

    const deserialized: any = {};
    const fieldSerializer = new FieldSerializer(this.table);
    const omittedFields: string[] = [];
    for (const columnName in prepared) {
      const serializedFieldValue = prepared[columnName];
      try {
        const { fieldPropertyName, fieldValue } = await fieldSerializer.deserialize(
          columnName,
          serializedFieldValue,
          prepared
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
    let column: Column<any, any> | undefined = columns[columnName]; // the scenario that the column name is the same as the property name
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
