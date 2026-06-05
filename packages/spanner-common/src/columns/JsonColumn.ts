import { Column, ColumnOptions } from '@proteinjs/db';

/**
 * Reserved key used to wrap a top-level array stored in a JSON column. Namespaced
 * so it cannot collide with a real object value's own fields. See JsonColumn.
 */
const JSON_ARRAY_MARKER = '__jsonColumnArray';

/**
 * A column backed by a Spanner `JSON` value.
 *
 * Spanner infers a DML parameter's type from the JS value's shape, so a top-level
 * ARRAY is sent as `ARRAY<JSON>` — which a `JSON` column rejects ("Value has type
 * ARRAY<JSON> which cannot be inserted into column ..., which has type JSON"). To
 * let a JSON column hold an array, we wrap arrays in a single marker object on
 * write (so the driver sends one JSON document) and unwrap on read. Object values
 * pass through untouched, so object-valued JSON columns are unaffected. The
 * wrapping is invisible to consumers — the field round-trips as the same array.
 */
export class JsonColumn<T> implements Column<T, any> {
  constructor(
    public name: string,
    public options?: ColumnOptions
  ) {}

  async serialize(fieldValue: T | null | undefined): Promise<any> {
    if (fieldValue === undefined || fieldValue == null) {
      return null;
    }

    if (Array.isArray(fieldValue)) {
      return { [JSON_ARRAY_MARKER]: fieldValue };
    }

    return fieldValue;
  }

  async deserialize(serializedFieldValue: any): Promise<T | null> {
    if (serializedFieldValue === undefined || serializedFieldValue == null) {
      return null;
    }

    // A raw array can appear if a row predates this wrapping; pass it through.
    if (Array.isArray(serializedFieldValue)) {
      return serializedFieldValue as T;
    }

    if (typeof serializedFieldValue === 'object' && Array.isArray(serializedFieldValue[JSON_ARRAY_MARKER])) {
      return serializedFieldValue[JSON_ARRAY_MARKER] as T;
    }

    return serializedFieldValue as T;
  }
}
