import { isInstanceOf } from '@proteinjs/util';
import { BinaryColumn, BooleanColumn, Column, DateColumn, DateTimeColumn, DecimalColumn, FloatColumn, IntegerColumn, StringColumn } from '@proteinjs/db';

// max size of a row in spanner is 10mb
export class SpannerColumnTypeFactory {
  getType(column: Column<any, any>): string {
    if (isInstanceOf(column, IntegerColumn))
      return 'INT64';
    else if (isInstanceOf(column, StringColumn))
      return `STRING(${(column as StringColumn).maxLength})`;
    else if (isInstanceOf(column, FloatColumn))
      return 'FLOAT64';
    else if (isInstanceOf(column, DecimalColumn))
      return (column as DecimalColumn).large ? 'BIGNUMERIC' : 'NUMERIC';
    else if (isInstanceOf(column, BooleanColumn))
      return 'BOOL';
    else if (isInstanceOf(column, DateColumn))
      return 'TIMESTAMP';
    else if (isInstanceOf(column, DateTimeColumn))
      return 'TIMESTAMP';
    else if (isInstanceOf(column, BinaryColumn))
      return `BYTES(${!(column as BinaryColumn).maxLength ? 'MAX' : (column as BinaryColumn).maxLength})`;
    
    throw new Error(`Invalid column type: ${column.constructor.name}, must extend a base column`);
  }
}