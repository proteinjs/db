import { isInstanceOf } from '@proteinjs/util';
import { BinaryColumn, BooleanColumn, Column, DateColumn, DateTimeColumn, DecimalColumn, FloatColumn, IntegerColumn, StringColumn, UuidColumn } from '@proteinjs/db';

// note: this might be specific to maria db
export class KnexColumnTypeFactory {
  getType(column: Column<any, any>): string {
    if (isInstanceOf(column, IntegerColumn))
      return (column as IntegerColumn).large ? 'bigint' : 'int';
    else if (isInstanceOf(column, UuidColumn))
      return 'char';
    else if (isInstanceOf(column, StringColumn))
      return (column as StringColumn).maxLength === 'MAX' ? 'longtext' : 'varchar';
    else if (isInstanceOf(column, FloatColumn))
      return 'float';
    else if (isInstanceOf(column, DecimalColumn))
      return 'decimal';
    else if (isInstanceOf(column, BooleanColumn))
      return 'tinyint';
    else if (isInstanceOf(column, DateColumn))
      return 'date';
    else if (isInstanceOf(column, DateTimeColumn))
      return 'datetime';
    else if (isInstanceOf(column, BinaryColumn))
      return (column as BinaryColumn).maxLength === 'MAX' ? 'longblob' : 'blob';
    
    throw new Error(`Invalid column type: ${column.constructor.name}, must extend a base column`);
  }
}