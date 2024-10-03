import { Column, ColumnOptions } from '@proteinjs/db';

export class JsonColumn<T> implements Column<T, any> {
  constructor(
    public name: string,
    public options?: ColumnOptions
  ) {}

  async serialize(fieldValue: T | null | undefined): Promise<T | null> {
    if (fieldValue === undefined || fieldValue == null) {
      return null;
    }

    return fieldValue;
  }

  async deserialize(serializedFieldValue: T): Promise<T | null> {
    if (serializedFieldValue === undefined || serializedFieldValue == null) {
      return null;
    }

    return serializedFieldValue;
  }
}
