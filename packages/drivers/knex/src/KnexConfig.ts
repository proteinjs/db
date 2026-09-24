export type KnexConfig = {
  host: string;
  user: string;
  password: string;
  dbName: string;
  /**
   * Deadline applied to every query and DML statement the driver runs, inside a transaction or
   * not (default 60_000ms). A statement that has not settled by the deadline is cancelled on the
   * server (`KILL QUERY`) and FAILS with an error naming the deadline, instead of holding its
   * connection for as long as the server lets it run. Schema operations (DDL) are exempt. The
   * driver reports this value as its per-operation deadline (`DbDriver.getOperationDeadlineMs`).
   */
  operationDeadlineMs?: number;
};
