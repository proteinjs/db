import { Logger } from '@proteinjs/logger';
import { ServiceError } from '@proteinjs/service';
import { Table, isTable } from '../Table';
import { TableAuth } from './TableAuth';

export class TableServiceAuth {
  private logger = new Logger({ name: this.constructor.name });

  canAccess(methodName: string, args: any[]): boolean {
    try {
      const table: Table<any> | undefined = args[0];
      if (!isTable(table)) {
        throw new Error(`[DbServiceAuth] Expected first arg to be a table`);
      }

      const tableAuth = new TableAuth();
      if (methodName === 'get' || methodName == 'query' || methodName == 'getRowCount') {
        tableAuth.canQuery(table as Table<any>, 'service');
      } else if (methodName === 'insert') {
        tableAuth.canInsert(table as Table<any>, 'service');
        this.checkServiceProtectedColumns(table as Table<any>, args[1]);
      } else if (methodName === 'update') {
        tableAuth.canUpdate(table as Table<any>, 'service');
        this.checkServiceProtectedColumns(table as Table<any>, args[1]);
      } else if (methodName === 'delete') {
        tableAuth.canDelete(table as Table<any>, 'service');
      } else {
        throw new Error(`User is not authorized to access unsupported Db service api: ${methodName}`);
      }
    } catch (error: any) {
      // A protected-column rejection carries a client-safe message — let it surface as the 400
      // body instead of collapsing into the generic authorization failure. Name check, not
      // instanceof: `ServiceError extends Error` loses its prototype chain under the service
      // package's compile target (same reason ServiceRouter's isServiceError checks `name`).
      if (error?.name === 'ServiceError') {
        throw error;
      }
      this.logger.error({ message: `Failed evaluating auth for method: ${methodName}`, error });
      return false;
    }

    return true;
  }

  /**
   * Enforce `Table.auth.serviceProtectedColumns`: columns that may never be SET through the
   * generic `DbService` RPC path. Setting one to `null`/leaving it absent passes (clearing is not
   * a reserved write); any other value is rejected with a `ServiceError` so the client sees a
   * specific, actionable error. Server-side `Db` usage never runs this check.
   */
  private checkServiceProtectedColumns(table: Table<any>, record: any): void {
    const protectedColumns = table.auth?.serviceProtectedColumns;
    if (!protectedColumns?.length || !record || typeof record !== 'object') {
      return;
    }

    for (const column of protectedColumns) {
      const value = record[column];
      if (value !== undefined && value !== null) {
        throw new ServiceError(`Column '${column}' cannot be written via the db service on table: ${table.name}`);
      }
    }
  }
}
