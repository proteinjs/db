import { CustomSerializer } from '@proteinjs/serializer';
import { Table, tableByName } from '../Table';

type SerializedTable = {
  tableName: string;
};

export const TableSerializerId = '@proteinjs/db/TableSerializer';

export class TableSerializer implements CustomSerializer {
  id = TableSerializerId;

  serialize(table: Table<any>): SerializedTable {
    return { tableName: table.name };
  }

  deserialize(serializedTable: SerializedTable): Table<any> {
    return tableByName(serializedTable.tableName);
  }
}
