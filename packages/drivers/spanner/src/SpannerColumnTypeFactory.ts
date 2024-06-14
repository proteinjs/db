import { isInstanceOf } from '@proteinjs/util';
import {
  BinaryColumn,
  BooleanColumn,
  Column,
  DateColumn,
  DateTimeColumn,
  DecimalColumn,
  FloatColumn,
  IntegerColumn,
  StringColumn,
} from '@proteinjs/db';

// max size of a row in spanner is 10mb
export class SpannerColumnTypeFactory {
  getType(column: Column<any, any>, isQueryOrDml?: boolean): string {
    let type: string;

    if (isInstanceOf(column, IntegerColumn)) {
      type = 'INT64';
    } else if (isInstanceOf(column, StringColumn)) {
      type = isQueryOrDml ? 'string' : `STRING(${(column as StringColumn).maxLength})`;
    } else if (isInstanceOf(column, FloatColumn)) {
      type = 'FLOAT64';
    } else if (isInstanceOf(column, DecimalColumn)) {
      type = (column as DecimalColumn).large ? 'BIGNUMERIC' : 'NUMERIC';
    } else if (isInstanceOf(column, BooleanColumn)) {
      type = 'BOOL';
    } else if (isInstanceOf(column, DateColumn)) {
      type = 'TIMESTAMP';
    } else if (isInstanceOf(column, DateTimeColumn)) {
      type = 'TIMESTAMP';
    } else if (isInstanceOf(column, BinaryColumn)) {
      type = isQueryOrDml
        ? 'bytes'
        : `BYTES(${!(column as BinaryColumn).maxLength ? 'MAX' : (column as BinaryColumn).maxLength})`;
    } else {
      throw new Error(`Invalid column type: ${column.constructor.name}, must extend a base column`);
    }

    return isQueryOrDml ? type.toLowerCase() : type;
  }
}
