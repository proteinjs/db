import { UserAuth } from '@proteinjs/user-auth';
import { Table } from '../Table';

/**
 * @public all users, including guests (do not need to be logged in), do not need any roles
 * @authenticated - users need to be logged in, do not need any roles
 * @roles string[] - authenticated users, having at least one of these roles
 * @permission - authenticated users holding an abstract permission slug, resolved to roles at
 * runtime through the consumer app's `PermissionRolesMapping` (see `UserAuth.hasPermission`).
 * Generic tables declare permissions; only the consumer names roles.
 */
export type PermissionIdentity = { permission: string };

export type Identity = 'public' | 'authenticated' | string[] | PermissionIdentity;

const isPermissionIdentity = (identity: Identity | undefined): identity is PermissionIdentity =>
  !!identity && typeof identity === 'object' && !Array.isArray(identity) && typeof identity.permission === 'string';

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
 * A table-auth denial. The message names the table and operation and is safe to show the caller
 * (it only echoes what they asked for). Name-tagged rather than relying on instanceof — the
 * prototype chain is unreliable across package compile targets (same reason ServiceRouter's
 * isServiceError checks `name`).
 */
export class TableAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TableAuthError';
  }
}

/**
 * Util to check which table operations a user can perform
 */
export class TableAuth {
  /**
   * Non-throwing capability read: whether the CURRENT user clears this operation's declared
   * door on this api. The seam UI derivation rides (db-ui's record-table affordances render
   * only the operations the declaration actually opens — a table with no insert door draws no
   * create button); the throwing guards below stay the enforcement path.
   *
   * Answers false — never throws — when the auth machinery itself cannot resolve a user (e.g.
   * a context whose source graph never loaded `AuthenticatedUserRepo`): the same fail-closed
   * reading UserAuth documents for a missing repo, applied to a capability READ.
   */
  canPerform(
    table: Table<any>,
    operation: 'query' | 'insert' | 'update' | 'delete',
    api: 'db' | 'service' = 'db'
  ): boolean {
    try {
      return this.canAccess(table, api, operation);
    } catch {
      return false;
    }
  }

  private canAccess(
    table: Table<any>,
    api: 'db' | 'service',
    operation: 'query' | 'insert' | 'update' | 'delete'
  ): boolean {
    const tableAuth = table.auth ? table.auth[api] : undefined;
    if (!tableAuth || Object.keys(tableAuth).length == 0) {
      return UserAuth.hasRole('admin');
    }

    return (
      tableAuth.all === 'public' ||
      tableAuth[operation] === 'public' ||
      (tableAuth.all === 'authenticated' && UserAuth.isLoggedIn()) ||
      (tableAuth[operation] === 'authenticated' && UserAuth.isLoggedIn()) ||
      (Array.isArray(tableAuth.all) && UserAuth.hasRoles(tableAuth.all, 'at least one')) ||
      (Array.isArray(tableAuth[operation]) && UserAuth.hasRoles(tableAuth[operation] as string[], 'at least one')) ||
      (isPermissionIdentity(tableAuth.all) && UserAuth.hasPermission(tableAuth.all.permission)) ||
      (isPermissionIdentity(tableAuth[operation]) &&
        UserAuth.hasPermission((tableAuth[operation] as PermissionIdentity).permission))
    );
  }

  canQuery(table: Table<any>, api: 'db' | 'service' = 'db'): void {
    if (!this.canAccess(table, api, 'query')) {
      throw new TableAuthError(`User is not authorized to query table: ${table.name}`);
    }
  }

  canInsert(table: Table<any>, api: 'db' | 'service' = 'db'): void {
    if (!this.canAccess(table, api, 'insert')) {
      throw new TableAuthError(`User is not authorized to insert records into table: ${table.name}`);
    }
  }

  canUpdate(table: Table<any>, api: 'db' | 'service' = 'db'): void {
    if (!this.canAccess(table, api, 'update')) {
      throw new TableAuthError(`User is not authorized to update records in table: ${table.name}`);
    }
  }

  canDelete(table: Table<any>, api: 'db' | 'service' = 'db'): void {
    if (!this.canAccess(table, api, 'delete')) {
      throw new TableAuthError(`User is not authorized to delete records from table: ${table.name}`);
    }
  }
}
