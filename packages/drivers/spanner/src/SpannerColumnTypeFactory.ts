import { BinaryColumn, BooleanColumn, Column, DateColumn, DateTimeColumn, DecimalColumn, FloatColumn, IntegerColumn, StringColumn } from '@proteinjs/db';

// max size of a row in spanner is 10mb
export class SpannerColumnTypeFactory {
  getType(column: Column<any, any>): string {
    if (column instanceof IntegerColumn)
      return 'INT64';
    else if (column instanceof StringColumn)
      return `STRING(${column.maxLength})`;
    else if (column instanceof FloatColumn)
      return 'FLOAT64';
    else if (column instanceof DecimalColumn)
      return column.large ? 'BIGNUMERIC' : 'NUMERIC';
    else if (column instanceof BooleanColumn)
      return 'BOOL';
    else if (column instanceof DateColumn)
      return 'DATE';
    else if (column instanceof DateTimeColumn)
      return 'TIMESTAMP';
    else if (column instanceof BinaryColumn)
      return `BYTES(${!(column as BinaryColumn).maxLength ? 'MAX' : (column as BinaryColumn).maxLength})`;
    
    throw new Error(`Invalid column type: ${column.constructor.name}, must extend a base column`);
  }
}