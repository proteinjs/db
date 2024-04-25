import { Logger } from '@proteinjs/util';
import { Table, isTable } from '../Table';
import { TableAuth } from './TableAuth';

export class TableServiceAuth {
  private logger = new Logger(this.constructor.name);

  canAccess(methodName: string, args: any[]): boolean {
    try {
      const table: Table<any>|undefined = args[0];
      if (!isTable(table))
        throw new Error(`[DbServiceAuth] Expected first arg to be a table`);
      
      const tableAuth = new TableAuth();
      if (methodName === 'get' || methodName == 'query' || methodName == 'getRowCount')
        tableAuth.canQuery(table as Table<any>, 'service');
      else if (methodName === 'insert')
        tableAuth.canInsert(table as Table<any>, 'service');
      else if (methodName === 'update')
        tableAuth.canUpdate(table as Table<any>, 'service');
      else if (methodName === 'delete')
        tableAuth.canDelete(table as Table<any>, 'service');
      else
        throw new Error(`User is not authorized to access unsupported Db service api: ${methodName}`);
    } catch (error: any) {
      this.logger.error(error.stack);
      return false;
    }

    return true;
  }
}