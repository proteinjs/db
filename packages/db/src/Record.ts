import { Logger } from '@proteinjs/logger';
import { DateTimeColumn, UuidColumn } from './Columns';
import { Column, Table, Columns } from './Table';
import { moment } from './opt/moment';
import type { EncryptionRecordHooks } from './encryption/EncryptionRecordHooks';

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

/** Who a row being written belongs to — the data key its encrypted columns encrypt under
 *  (see `EncryptionRecordHooks`). Resolved by `Db` for writes touching encrypted columns. */
export type RecordEncryptionContext = { keyOwner: string };

/** One column's seat in a hydration: the property the record carries it under, and the column. */
interface HydrationSlot {
  propertyName: string;
  column: Column<any, any>;
}

/**
 * What a hydration resolves ONCE per serializer, never per row: the decryption hook and every
 * column's seat, keyed by the name a stored row carries it under.
 */
interface HydrationPlan {
  hooks: EncryptionRecordHooks;
  slotsByColumnName: { [columnName: string]: HydrationSlot | undefined };
}

export class RecordSerializer<T extends Record> {
  private logger = new Logger({ name: this.constructor.name });
  private table: Table<T>;
  private encryptionContext?: RecordEncryptionContext;
  private plan?: HydrationPlan;

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

  /**
   * A result set's rows → records, in ONE pass. A row whose hook and columns all answer directly
   * is hydrated synchronously, and when every row did the array returns synchronously: no promise
   * per row, no yield of the event loop between rows. A row that needs an await — a ciphertext
   * envelope to decrypt, a column whose `deserialize` answers with a promise — settles through one
   * promise for the whole set. The hook and the column seats are resolved once per serializer.
   */
  deserializeAll(serializedRecords: SerializedRecord[]): T[] | Promise<T[]> {
    const plan = this.hydrationPlan();
    const records: (T | Promise<T>)[] = new Array(serializedRecords.length);
    let settles = false;
    for (let i = 0; i < serializedRecords.length; i++) {
      const record = this.hydrate(plan, serializedRecords[i]);
      if (this.isPromise(record)) {
        settles = true;
      }
      records[i] = record;
    }

    return settles ? Promise.all(records) : (records as T[]);
  }

  /** One row → one record (`deserializeAll` is the door for a result set). */
  async deserialize(serializedRecord: SerializedRecord): Promise<T> {
    return await this.hydrate(this.hydrationPlan(), serializedRecord);
  }

  private hydrate(plan: HydrationPlan, serializedRecord: SerializedRecord): T | Promise<T> {
    // The transparent decryption seam: ciphertext envelopes decrypt (self-describing — the
    // envelope names its key), framework companion columns drop out of the result. The hook
    // answers directly for a row holding no envelope.
    const prepared = plan.hooks.onDeserialize(this.table, serializedRecord);
    if (this.isPromise(prepared)) {
      return prepared.then((row) => this.hydratePrepared(plan, row));
    }

    return this.hydratePrepared(plan, prepared);
  }

  private hydratePrepared(plan: HydrationPlan, prepared: SerializedRecord): T | Promise<T> {
    const record: any = {};
    let settling: Promise<void>[] | undefined;
    let omittedFields: string[] | undefined;
    for (const columnName in prepared) {
      const slot = plan.slotsByColumnName[columnName];
      if (!slot) {
        // a column exists in the db that is no longer defined in Table.columns
        (omittedFields ??= []).push(columnName);
        continue;
      }

      const { propertyName, column } = slot;
      const storedValue = prepared[columnName];
      if (!column.deserialize) {
        record[propertyName] = storedValue;
        continue;
      }

      if (column.deserializeOnFirstRead && storedValue !== null && storedValue !== undefined) {
        this.defineFieldReadOnFirstRead(record, propertyName, column, storedValue);
        continue;
      }

      const fieldValue = column.deserialize(storedValue, prepared);
      if (this.isPromise(fieldValue)) {
        record[propertyName] = undefined; // seats the property in column order; the value lands when it settles
        (settling ??= []).push(
          fieldValue.then((value) => {
            record[propertyName] = value;
          })
        );
        continue;
      }

      record[propertyName] = fieldValue;
    }

    if (omittedFields) {
      // expected when passing a base table into the query api
      this.logger.debug({ message: `Fields were omitted during deserialization`, obj: { omittedFields } });
    }

    if (settling) {
      return Promise.all(settling).then(() => record as T);
    }

    return record as T;
  }

  /**
   * The field as an own, enumerable property whose value is deserialized on its first read, once
   * (`Column.deserializeOnFirstRead`); a write replaces it like any other field.
   */
  private defineFieldReadOnFirstRead(
    record: any,
    propertyName: string,
    column: Column<any, any>,
    storedValue: unknown
  ): void {
    let value: unknown;
    let read = false;
    Object.defineProperty(record, propertyName, {
      enumerable: true,
      configurable: true,
      get() {
        if (!read) {
          value = column.deserialize!(storedValue, undefined);
          read = true;
        }

        return value;
      },
      set(next: unknown) {
        value = next;
        read = true;
      },
    });
  }

  private hydrationPlan(): HydrationPlan {
    if (this.plan) {
      return this.plan;
    }

    // Required at call time — this module sits below the encryption machinery in the package's
    // module graph (the seam `Table.ts` uses for the same reason).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EncryptionRecordHooks } =
      require('./encryption/EncryptionRecordHooks') as typeof import('./encryption/EncryptionRecordHooks');
    const slotsByColumnName: HydrationPlan['slotsByColumnName'] = {};
    const columns: { [propertyName: string]: Column<any, any> } = this.table.columns;
    // Seated by column name, then by property name — a stored key that is a property name
    // resolves to that property's column first, as it always has.
    for (const propertyName in columns) {
      slotsByColumnName[columns[propertyName].name] = { propertyName, column: columns[propertyName] };
    }
    for (const propertyName in columns) {
      slotsByColumnName[propertyName] = { propertyName, column: columns[propertyName] };
    }

    this.plan = { hooks: new EncryptionRecordHooks(), slotsByColumnName };
    return this.plan;
  }

  private isPromise<V>(value: V | Promise<V>): value is Promise<V> {
    return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
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
