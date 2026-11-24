import { Logger } from '@proteinjs/logger';
import { ServiceError, ServiceRefusal } from '@proteinjs/service';
import { isInstanceOf } from '@proteinjs/util';
import { QueryBuilder } from '@proteinjs/db-query';
import { Table, isTable, tableByName } from '../Table';
import type { HeldQueryOptions } from '../Db';
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
        this.checkServiceQuery(table as Table<any>, args[1]);
        // A count takes no options: only a read that can preload has its options held.
        if (methodName !== 'getRowCount') {
          this.holdPreloadToTheServiceDoor(table as Table<any>, args[2]);
        }
      } else if (methodName === 'insert') {
        tableAuth.canInsert(table as Table<any>, 'service');
        this.checkServiceProtectedColumns(table as Table<any>, args[1]);
      } else if (methodName === 'update') {
        tableAuth.canUpdate(table as Table<any>, 'service');
        this.checkServiceProtectedColumns(table as Table<any>, args[1]);
        this.checkServiceQuery(table as Table<any>, args[2], true);
      } else if (methodName === 'updateArrayMembership') {
        // An update in RMW clothing: gated exactly like `update`. Row visibility is enforced
        // inside the operation itself — scoped/column query injection runs on the server-side
        // read-modify-write, so a caller can only touch rows they could already update.
        tableAuth.canUpdate(table as Table<any>, 'service');
        this.checkArrayMembershipProtectedColumn(table as Table<any>, args[1]);
      } else if (methodName === 'updatePreserving') {
        tableAuth.canUpdate(table as Table<any>, 'service');
        this.checkServiceProtectedColumns(table as Table<any>, args[1]);
      } else if (methodName === 'delete') {
        tableAuth.canDelete(table as Table<any>, 'service');
        this.checkServiceQuery(table as Table<any>, args[1], true);
      } else {
        throw new Error(`User is not authorized to access unsupported Db service api: ${methodName}`);
      }
    } catch (error: any) {
      // A deliberate refusal (a durable table's delete door) reaches the caller as it is: the
      // router answers with its status and message.
      if (ServiceRefusal.is(error)) {
        throw error;
      }
      // A protected-column rejection carries a client-safe message — let it surface as the 400
      // body instead of collapsing into the generic authorization failure. Name check, not
      // instanceof: `ServiceError extends Error` loses its prototype chain under the service
      // package's compile target (same reason ServiceRouter's isServiceError checks `name`).
      if (error?.name === 'ServiceError') {
        throw error;
      }
      // A table-auth denial is equally client-safe (it only names the table/operation the caller
      // asked for). Cross the wire verbatim so the caller sees "not authorized to query table:
      // session" rather than the generic run-service denial — a denied query must be
      // distinguishable from an empty one at the surface that shows it.
      if (error?.name === 'TableAuthError') {
        throw new ServiceError(error.message);
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

  /**
   * A query that comes through the service is a description of rows of the table asked. It is read here
   * the way the Db will read it ({@link QueryBuilder.rebuiltFrom}): it has to describe a query of that
   * table, and each query inside it is a query of a table of its own, so that table's service door is
   * asked as well. The Db then builds its own builder from the same description and adds each table's
   * column queries to it. A query written as an object holds values, not queries. The query of an update
   * or a delete (`forAWrite`) says which rows and nothing else ({@link QueryBuilder.saysOnlyWhichRows}).
   */
  private checkServiceQuery(table: Table<any>, query: any, forAWrite: boolean = false): void {
    if (!query || typeof query !== 'object') {
      return;
    }

    if (!isInstanceOf(query, QueryBuilder)) {
      const holdsAQuery = (value: any) =>
        isInstanceOf(value, QueryBuilder) ||
        (Array.isArray(value) && value.some((item) => isInstanceOf(item, QueryBuilder)));
      if (Object.keys(query).some((prop) => holdsAQuery(query[prop]))) {
        throw new ServiceError(
          `A query written as an object holds values, not a query: it cannot be run via the db service on table: ${table.name}`
        );
      }
      return;
    }

    const queriesWithin: QueryBuilder<any>[] = [];
    let described: QueryBuilder<any> = query;
    if (!QueryBuilder.isTheCodesOwn(query)) {
      try {
        described = QueryBuilder.rebuiltFrom(query, (within) => queriesWithin.push(within));
      } catch {
        throw new ServiceError(
          `A query that is not one a builder writes cannot be run via the db service on table: ${table.name}`
        );
      }
    }

    if (described.tableName !== table.name) {
      throw new ServiceError(
        `A query built for another table cannot be run via the db service on table: ${table.name}`
      );
    }

    if (forAWrite && !described.saysOnlyWhichRows()) {
      throw new ServiceError(
        `An update's or a delete's query says which rows and nothing else: this one cannot be run via the db service on table: ${table.name}`
      );
    }

    const tableAuth = new TableAuth();
    for (const within of queriesWithin) {
      tableAuth.canQuery(this.tableWithin(table, within), 'service');
    }
  }

  /**
   * A read through the service may ask for the rows its result's references point at
   * (`QueryOptions.preloadReferences`). Each referenced table is a table of its own: it is loaded only when its
   * own service door admits the caller for a query. The Db asks through the preload's `admits` (`PreloadHold`),
   * which is set here whatever the call held under that name; a table the door does not admit is left unloaded,
   * for the caller to ask for itself. The answer is written onto the options a call's text reads as, which are
   * plain objects: any other object in their place is refused, never written on.
   */
  private holdPreloadToTheServiceDoor(table: Table<any>, options: unknown): void {
    if (options === null || typeof options !== 'object') {
      return;
    }

    const refusal = `Read options that are not a plain object cannot be run via the db service on table: ${table.name}`;
    if (!TableServiceAuth.isPlainObject(options)) {
      throw new ServiceError(refusal);
    }

    const preload: unknown = (options as HeldQueryOptions<any>).preloadReferences;
    if (preload === null || typeof preload !== 'object') {
      return;
    }

    if (!TableServiceAuth.isPlainObject(preload)) {
      throw new ServiceError(refusal);
    }

    const tableAuth = new TableAuth();
    const held: NonNullable<HeldQueryOptions<any>['preloadReferences']> = preload as any;
    held.admits = (tableName: string): boolean => {
      let referenced: Table<any>;
      try {
        referenced = tableByName(tableName);
      } catch {
        this.logger.warn({
          message: `A reference names a table that is not declared: left unloaded`,
          obj: {
            table: table.name,
            referenced: typeof tableName === 'string' ? tableName.slice(0, 80) : `a ${typeof tableName}`,
          },
        });
        return false;
      }

      return tableAuth.canPerform(referenced, 'query', 'service');
    };
  }

  /** An object as a call's text reads one: made by `{}` or with no prototype, never an array or a class's instance. */
  private static isPlainObject(value: object): boolean {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  /** The table a query inside a query names. */
  private tableWithin(table: Table<any>, within: QueryBuilder<any>): Table<any> {
    try {
      return tableByName(within.tableName);
    } catch {
      throw new ServiceError(
        `A query within a query names no table: it cannot be run via the db service on table: ${table.name}`
      );
    }
  }

  /**
   * `updateArrayMembership`'s payload names its target column (`columnPropertyName`) instead of
   * carrying record fields, so the record-shaped protected-column check above can't see the
   * write. Membership ops always SET real membership — there is no null-clearing form — so
   * targeting a protected column is rejected outright.
   */
  private checkArrayMembershipProtectedColumn(table: Table<any>, update: any): void {
    const protectedColumns: string[] | undefined = table.auth?.serviceProtectedColumns;
    if (!protectedColumns?.length || !update || typeof update !== 'object') {
      return;
    }

    if (protectedColumns.includes(update.columnPropertyName)) {
      throw new ServiceError(
        `Column '${update.columnPropertyName}' cannot be written via the db service on table: ${table.name}`
      );
    }
  }
}
