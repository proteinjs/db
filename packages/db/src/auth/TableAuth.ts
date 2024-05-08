import { UserAuth } from '@proteinjs/user-auth';
import { Table } from '../Table';

/**
 * @public all users, including guests (do not need to be logged in), do not need any roles
 * @authenticated - users need to be logged in, do not need any roles
 * @roles string[] - authenticated users, having at least one of these roles
 */
export type Identity = 'public' | 'authenticated' | string[];

/**
 * These Identities can perform these operations on this table.
 * If omitted, defaults to requiring the 'admin' role (default deny)
 */
export type TableOperationsAuth = {
  all?: Identity;
  query?: Identity;
  insert?: Identity;
  update?: Identity;
  delete?: Identity;
};

/**
 * Util to check which table operations a user can perform
 */
export class TableAuth {
  private canAccess(
    table: Table<any>,
    api: 'db' | 'service',
    operation: 'query' | 'insert' | 'update' | 'delete'
  ): boolean {
    const tableAuth = table.auth ? table.auth[api] : undefined;
    if (!tableAuth || Object.keys(tableAuth).length == 0) return UserAuth.hasRole('admin');

    return (
      tableAuth.all === 'public' ||
      tableAuth[operation] === 'public' ||
      (tableAuth.all === 'authenticated' && UserAuth.isLoggedIn()) ||
      (tableAuth[operation] === 'authenticated' && UserAuth.isLoggedIn()) ||
      (Array.isArray(tableAuth.all) && UserAuth.hasRoles(tableAuth.all, 'at least one')) ||
      (Array.isArray(tableAuth[operation]) && UserAuth.hasRoles(tableAuth[operation] as string[], 'at least one'))
    );
  }

  canQuery(table: Table<any>, api: 'db' | 'service' = 'db'): void {
    if (!this.canAccess(table, api, 'query')) throw new Error(`User is not authorized to query table: ${table.name}`);
  }

  canInsert(table: Table<any>, api: 'db' | 'service' = 'db'): void {
    if (!this.canAccess(table, api, 'insert'))
      throw new Error(`User is not authorized to insert records into table: ${table.name}`);
  }

  canUpdate(table: Table<any>, api: 'db' | 'service' = 'db'): void {
    if (!this.canAccess(table, api, 'update'))
      throw new Error(`User is not authorized to update records in table: ${table.name}`);
  }

  canDelete(table: Table<any>, api: 'db' | 'service' = 'db'): void {
    if (!this.canAccess(table, api, 'query'))
      throw new Error(`User is not authorized to delete records from table: ${table.name}`);
  }
}
