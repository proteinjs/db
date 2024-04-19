import { BinaryColumn, BooleanColumn, Column, DateColumn, DateTimeColumn, DecimalColumn, FloatColumn, IntegerColumn, StringColumn, UuidColumn } from '@proteinjs/db';

// note: this might be specific to maria db
export class KnexColumnTypeFactory {
  getType(column: Column<any, any>): string {
    if (column instanceof IntegerColumn)
      return column.large ? 'bigint' : 'int';
    else if (column instanceof UuidColumn)
      return 'char';
    else if (column instanceof StringColumn)
      return column.maxLength === 'MAX' ? 'longtext' : 'varchar';
    else if (column instanceof FloatColumn)
      return 'float';
    else if (column instanceof DecimalColumn)
      return 'decimal';
    else if (column instanceof BooleanColumn)
      return 'tinyint';
    else if (column instanceof DateColumn)
      return 'date';
    else if (column instanceof DateTimeColumn)
      return 'datetime';
    else if (column instanceof BinaryColumn)
      return (column as BinaryColumn).maxLength === 'MAX' ? 'longblob' : 'blob';
    
    throw new Error(`Invalid column type: ${column.constructor.name}, must extend a base column`);
  }
}