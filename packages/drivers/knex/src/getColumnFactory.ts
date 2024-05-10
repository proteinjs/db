import knex from 'knex';
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
  UuidColumn,
} from '@proteinjs/db';

export const getColumnFactory = (column: Column<any, any>): ColumnFactory => {
  if (isInstanceOf(column, IntegerColumn)) {
    return new IntegerColumnFactory();
  } else if (isInstanceOf(column, UuidColumn)) {
    return new UuidColumnFactory();
  } else if (isInstanceOf(column, StringColumn)) {
    return new StringColumnFactory();
  } else if (isInstanceOf(column, FloatColumn)) {
    return new FloatColumnFactory();
  } else if (isInstanceOf(column, DecimalColumn)) {
    return new DecimalColumnFactory();
  } else if (isInstanceOf(column, BooleanColumn)) {
    return new BooleanColumnFactory();
  } else if (isInstanceOf(column, DateColumn)) {
    return new DateColumnFactory();
  } else if (isInstanceOf(column, DateTimeColumn)) {
    return new DateTimeColumnFactory();
  } else if (isInstanceOf(column, BinaryColumn)) {
    return new BinaryColumnFactory();
  }

  throw new Error(`Invalid column type: ${column.constructor.name}, must extend a base column`);
};

export interface ColumnFactory {
  create(column: Column<any, any>, tableBuilder: knex.TableBuilder): knex.ColumnBuilder;
}

export class IntegerColumnFactory implements ColumnFactory {
  create(integerColumn: IntegerColumn, tableBuilder: knex.TableBuilder): knex.ColumnBuilder {
    return integerColumn.large ? tableBuilder.bigInteger(integerColumn.name) : tableBuilder.integer(integerColumn.name);
  }
}

// max length of longtext is 4,294,967,295 bytes (~4 GiB)
export class StringColumnFactory implements ColumnFactory {
  create(stringColumn: StringColumn, tableBuilder: knex.TableBuilder): knex.ColumnBuilder {
    return stringColumn.maxLength === 'MAX'
      ? tableBuilder.text(stringColumn.name, 'longtext')
      : tableBuilder.string(stringColumn.name, stringColumn.maxLength);
  }
}

export class FloatColumnFactory implements ColumnFactory {
  create(floatColumn: FloatColumn, tableBuilder: knex.TableBuilder): knex.ColumnBuilder {
    return tableBuilder.float(floatColumn.name);
  }
}

export class DecimalColumnFactory implements ColumnFactory {
  create(decimalColumn: DecimalColumn, tableBuilder: knex.TableBuilder): knex.ColumnBuilder {
    return decimalColumn.large
      ? tableBuilder.decimal(decimalColumn.name, 38, 20)
      : tableBuilder.decimal(decimalColumn.name);
  }
}

export class BooleanColumnFactory implements ColumnFactory {
  create(booleanColumn: BooleanColumn, tableBuilder: knex.TableBuilder): knex.ColumnBuilder {
    return tableBuilder.boolean(booleanColumn.name);
  }
}

export class DateColumnFactory implements ColumnFactory {
  create(dateColumn: DateColumn, tableBuilder: knex.TableBuilder): knex.ColumnBuilder {
    return tableBuilder.date(dateColumn.name);
  }
}

export class DateTimeColumnFactory implements ColumnFactory {
  create(dateTimeColumn: DateTimeColumn, tableBuilder: knex.TableBuilder): knex.ColumnBuilder {
    return tableBuilder.dateTime(dateTimeColumn.name);
  }
}

// max length of longblob is 4,294,967,295 bytes (~4 GiB)
// max length when undefined (aka blob) is 65,535 bytes (~64 KiB)
export class BinaryColumnFactory implements ColumnFactory {
  create(binaryColumn: BinaryColumn, tableBuilder: knex.TableBuilder): knex.ColumnBuilder {
    return binaryColumn.maxLength == 'MAX'
      ? tableBuilder.specificType(binaryColumn.name, 'longblob')
      : tableBuilder.binary(binaryColumn.name, binaryColumn.maxLength);
  }
}

export class UuidColumnFactory implements ColumnFactory {
  create(uuidColumn: UuidColumn, tableBuilder: knex.TableBuilder): knex.ColumnBuilder {
    return tableBuilder.uuid(uuidColumn.name);
  }
}
