import { Database, Instance, Spanner, Transaction } from '@google-cloud/spanner';
import {
  DbDriver,
  DbDriverQueryStatementConfig,
  DbDriverDmlStatementConfig,
  Table,
  TableManager,
  tableByName,
} from '@proteinjs/db';
import { SpannerConfig } from './SpannerConfig';
import { SpannerLivenessMonitor } from './SpannerLivenessMonitor';
import { Logger } from '@proteinjs/logger';
import { Statement } from '@proteinjs/db-query';
import { SpannerSchemaOperations } from './SpannerSchemaOperations';
import { SpannerColumnTypeFactory } from './SpannerColumnTypeFactory';
import { SpannerSchemaMetadata } from './SpannerSchemaMetadata';

/**
 * Google Spanner driver for ProteinJs Db
 */
export class SpannerDriver implements DbDriver {
  private static SPANNER?: Spanner;
  private static SPANNER_INSTANCE?: Instance;
  private static SPANNER_DB?: Database;
  private static LIVENESS_MONITOR: SpannerLivenessMonitor;
  /**
   * Channel-death recycle accounting (2026-08-06 overnight wedge). Ops are tagged with the
   * generation of the client they started on; only same-generation outcomes touch the counter,
   * so a burst of deadline failures from the OLD (recycled) channel can never spuriously
   * recycle the fresh one.
   */
  private static CLIENT_GENERATION = 0;
  private static CONSECUTIVE_DEADLINE_FAILURES = 0;
  private logger = new Logger({ name: this.constructor.name });
  private config: SpannerConfig;
  public getTable: ((name: string) => Table<any>) | undefined;

  constructor(config: SpannerConfig, getTable?: (name: string) => Table<any>) {
    this.config = config;
    this.getTable = getTable;
  }

  private getSpanner(): Spanner {
    if (!SpannerDriver.SPANNER) {
      // gRPC channel keepalive (2026-07-11 flow-hang investigation): a call in flight on a dead
      // transport (NAT/VPN/middlebox drop with no RST) waits forever with zero open sockets and
      // no error, wedging whatever await rides it. Keepalive pings during ACTIVE calls detect the
      // dead channel within ~40s and fail the call over to gRPC's reconnect + retry machinery.
      // Deliberately NOT `permit_without_calls`: idle-channel pings are treated as protocol abuse
      // by some servers — the Spanner emulator in CI answered them with RST_STREAM(2) "Protocol
      // error", killing every suite (2026-07-21 publish failure). Active-call pings still cover
      // the wedge (the failure mode IS a hung in-flight call); a dead idle channel just pays one
      // ~40s detection on its first call instead. Set SPANNER_GRPC_KEEPALIVE_TIME_MS=0 to disable
      // keepalive entirely; callers may also override via spannerOptions.
      const keepaliveTimeMs = Number(process.env.SPANNER_GRPC_KEEPALIVE_TIME_MS ?? 30_000);
      const keepalive =
        keepaliveTimeMs > 0
          ? {
              'grpc.keepalive_time_ms': keepaliveTimeMs,
              'grpc.keepalive_timeout_ms': Number(process.env.SPANNER_GRPC_KEEPALIVE_TIMEOUT_MS || 10_000),
              'grpc.keepalive_permit_without_calls': 0,
            }
          : {};
      if (this.config.spannerOptions) {
        SpannerDriver.SPANNER = new Spanner(
          Object.assign({ projectId: this.config.projectId }, keepalive, this.config.spannerOptions)
        );
      } else {
        SpannerDriver.SPANNER = new Spanner({ projectId: this.config.projectId, ...keepalive });
      }
    }

    return SpannerDriver.SPANNER;
  }

  private getSpannerInstance(): Instance {
    if (!SpannerDriver.SPANNER_INSTANCE) {
      SpannerDriver.SPANNER_INSTANCE = this.getSpanner().instance(this.config.instanceName);
    }

    return SpannerDriver.SPANNER_INSTANCE;
  }

  private getSpannerDb(): Database {
    if (!SpannerDriver.SPANNER_DB) {
      SpannerDriver.SPANNER_DB = this.getSpannerInstance().database(
        this.config.databaseName,
        this.config.sessionPoolOptions
      );
      SpannerDriver.LIVENESS_MONITOR = new SpannerLivenessMonitor(SpannerDriver.SPANNER_DB).start();
    }

    return SpannerDriver.SPANNER_DB;
  }

  getDbName() {
    return this.config.databaseName;
  }

  getTableManager(): TableManager {
    const columnTypeFactory = new SpannerColumnTypeFactory();
    const schemaOperations = new SpannerSchemaOperations(this);
    const schemaMetadata = new SpannerSchemaMetadata(this, false);
    return new TableManager(this, columnTypeFactory, schemaOperations, schemaMetadata);
  }

  /**
   * Retrieves spanner specific types for columns.
   * @param tableName Table name as it is represented in the db
   * @param columnName Column name as it is represented in the db
   * @returns
   */
  getColumnType(tableName: string, columnName: string): string {
    const table = this.getTable ? this.getTable(tableName) : tableByName(tableName);
    const column = Object.values(table.columns).find((col) => col.name === columnName);

    if (!column) {
      throw new Error(`Column ${columnName} does not exist in table ${table.name}`);
    }

    const type = new SpannerColumnTypeFactory().getType(column, true);

    if (!type) {
      throw new Error(`Type was not resolved for column ${columnName} in table ${table.name}`);
    }

    return type;
  }

  /**
   * Spanner is case sensitive by default.
   * If we want to query without case sensitivity, wrap the column name with the `LOWER()` function.
   * @returns identifier to be used in SQL statement, may instead be an expression if using case insensitivity
   */
  handleCaseSensitivity(tableName: string, columnName: string, caseSensitive: boolean): string {
    if (caseSensitive) {
      return columnName;
    }

    const isStringColType = this.getColumnType(tableName, columnName) === 'string';

    if (isStringColType) {
      return `LOWER(${columnName})`;
    }

    return columnName;
  }

  async createDbIfNotExists(): Promise<void> {
    if (await this.dbExists(this.getDbName())) {
      return;
    }

    await this.getSpannerInstance().createDatabase(this.getDbName());
  }

  private async dbExists(databaseName: string): Promise<boolean> {
    const [exists] = await this.getSpannerInstance().database(databaseName).exists();
    return exists;
  }

  /**
   * Execute a query.
   */
  async runQuery(
    generateStatement: (config: DbDriverQueryStatementConfig) => Statement,
    transaction?: Transaction
  ): Promise<any[]> {
    return await this.executeQuery(generateStatement, transaction || this.getSpannerDb());
  }

  private async executeQuery(
    generateStatement: (config: DbDriverQueryStatementConfig) => Statement,
    runner: Database | Transaction
  ): Promise<any[]> {
    const { sql, namedParams } = generateStatement({
      useParams: true,
      useNamedParams: true,
      prefixTablesWithDb: false,
      getDriverColumnType: this.getColumnType.bind(this),
      handleCaseSensitivity: this.handleCaseSensitivity.bind(this),
    });

    const startTime = process.hrtime.bigint();

    try {
      this.logger.debug({ message: `Executing query`, obj: { sql, params: namedParams } });
      const [rows] = await this.withDeadline(
        'spanner query',
        sql,
        runner.run({
          sql,
          params: namedParams?.params,
          types: namedParams?.types,
          // The gRPC deadline is what actually cancels the RPC on a dead channel: the stream
          // errors, the library ends the snapshot, and the borrowed session RETURNS to the
          // pool. The withDeadline race alone would fail the caller but leak the session.
          gaxOptions: { timeout: this.operationDeadlineMs() },
        })
      );
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.debug({
        message: `Query executed`,
        obj: { sql, durationMs, rowCount: rows.length },
      });
      return rows.map((row) => row.toJSON());
    } catch (error: any) {
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.error({
        message: `Failed when executing query`,
        obj: { sql, params: namedParams, errorDetails: error.details, durationMs },
      });
      SpannerDriver.LIVENESS_MONITOR.reportError(error);
      throw error;
    }
  }

  /**
   * Execute a write operation.
   *
   * @returns number of affected rows
   */
  async runDml(
    generateStatement: (config: DbDriverDmlStatementConfig) => Statement,
    transaction?: Transaction
  ): Promise<number> {
    if (transaction) {
      return await this.executeDml(generateStatement, transaction);
    }

    // Stalls in the transaction wrapper itself (session acquisition / begin / commit) happen
    // OUTSIDE executeDml's instrumentation — wrap the whole round trip too. Every await inside
    // the run function is deadline-bounded (dml, commit, rollback): the run function therefore
    // ALWAYS settles, which is what makes runTransactionAsync's own `finally` release the
    // transaction's session back to the pool on a dead channel.
    return await this.withDeadline(
      'spanner dml transaction',
      '(runTransactionAsync)',
      this.getSpannerDb().runTransactionAsync(async (transaction) => {
        try {
          const rowCount = await this.executeDml(generateStatement, transaction);
          await this.commit(transaction);
          return rowCount;
        } catch (error) {
          await this.rollbackQuietly(transaction);
          throw error;
        }
      })
    );
  }

  private async executeDml(
    generateStatement: (config: DbDriverDmlStatementConfig) => Statement,
    runner: Transaction
  ): Promise<number> {
    const { sql, namedParams } = generateStatement({
      useParams: true,
      useNamedParams: true,
      prefixTablesWithDb: false,
      getDriverColumnType: this.getColumnType.bind(this),
    });

    const startTime = process.hrtime.bigint();

    try {
      this.logger.debug({ message: `Executing dml`, obj: { sql, params: namedParams } });
      const [rowCount] = await this.withDeadline(
        'spanner dml',
        sql,
        runner.runUpdate({
          sql,
          params: namedParams?.params,
          types: namedParams?.types,
          // gRPC deadline: cancels the RPC on a dead channel so the transaction's run function
          // settles and the library releases the session (see runDml).
          gaxOptions: { timeout: this.operationDeadlineMs() },
        })
      );
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.debug({
        message: `Dml executed`,
        obj: { sql, durationMs, rowCount },
      });
      return rowCount;
    } catch (error: any) {
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.error({
        message: `Failed when executing dml`,
        obj: { sql, params: namedParams, errorDetails: error.details, durationMs },
      });
      SpannerDriver.LIVENESS_MONITOR.reportError(error);
      throw error;
    }
  }

  /**
   * Execute a transaction.
   * @param fn all db operations within this function will be part of this transaction
   * @returns the return of the `fn`
   */
  async runTransaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    return await this.withDeadline(
      'spanner transaction',
      '(runTransactionAsync)',
      this.getSpannerDb().runTransactionAsync(async (transaction) => {
        try {
          const result = await fn(transaction);
          await this.commit(transaction);
          return result;
        } catch (error) {
          await this.rollbackQuietly(transaction);
          throw error;
        }
      })
    );
  }

  /**
   * Deadline-bounded commit: a commit hanging on a dead channel would otherwise keep the
   * transaction's run function pending forever, and with it the session (runTransactionAsync
   * only releases the session once the run function settles).
   */
  private async commit(transaction: Transaction): Promise<void> {
    await this.withDeadline(
      'spanner commit',
      '(commit)',
      transaction.commit({ gaxOptions: { timeout: this.operationDeadlineMs() } })
    );
  }

  /**
   * Release a transaction whose work errored. The client library's runner does NOT roll back on
   * non-retryable errors — it just rethrows — so a thrown `fn` (e.g. an application rollback, or
   * a failed statement) left the read-write transaction OPEN until session timeout. Real Spanner
   * tolerates that (locks expire); the emulator serializes on its single read-write transaction,
   * so one leaked transaction blocks every subsequent DDL with FAILED_PRECONDITION ("a
   * read-write transaction is already in progress") — poisoning whole test runs. Rollback of an
   * already-invalid transaction (e.g. ABORTED, about to be retried by the runner with a fresh
   * transaction, or one whose commit was already called) is expected to fail; that failure is
   * logged at debug and swallowed so the ORIGINAL error — the one that carries retry semantics —
   * always propagates. Deadline-bounded like commit: an unbounded rollback on a dead channel
   * would keep the run function (and its session) pending forever.
   */
  private async rollbackQuietly(transaction: Transaction): Promise<void> {
    try {
      await this.withDeadline(
        'spanner rollback',
        '(rollback)',
        transaction.rollback({ timeout: this.operationDeadlineMs() })
      );
    } catch (rollbackError: any) {
      this.logger.debug({ message: `Rollback after transaction error failed`, obj: { rollbackError } });
    }
  }

  /**
   * The one choke point every query/dml/transaction op awaits through. Two jobs:
   *
   * 1. Stall diagnostics (2026-07-10 flow-hang investigation): logs ops still pending at 30s
   *    and 120s with the op and statement.
   * 2. OP DEADLINE (2026-08-06 overnight wedge): an op that has not settled by
   *    `operationDeadlineMs` (default 60s) FAILS with an error naming the deadline instead of
   *    hanging forever on a dead gRPC channel. This race covers hangs the gRPC deadline cannot
   *    see (session-pool acquisition, library internals before the RPC starts); the
   *    wire-level cancellation + session return is the gRPC deadline attached per call
   *    (`gaxOptions.timeout`, same value) — see the call sites. Deadline failures feed the
   *    channel-death recycle counter; any success resets it.
   */
  private withDeadline<T>(op: string, sql: string, promise: PromiseLike<T>): Promise<T> {
    // Pool gauge (P4a): every op passes through here, so this is where waiting-on-the-pool
    // becomes visible (throttled inside the monitor). The monitor exists by now — all ops
    // require getSpannerDb() first.
    SpannerDriver.LIVENESS_MONITOR.logPoolPressure();
    const deadlineMs = this.operationDeadlineMs();
    const generation = SpannerDriver.CLIENT_GENERATION;
    let settled = false;
    const logStall = (afterMs: number) =>
      this.logger.error({
        message: `Spanner op stalled: ${op}`,
        obj: { afterMs, sql: String(sql).slice(0, 200), pool: SpannerDriver.LIVENESS_MONITOR.poolStats() },
      });
    const t1 = setTimeout(() => {
      if (!settled) {
        logStall(30_000);
      }
    }, 30_000);
    const t2 = setTimeout(() => {
      if (!settled) {
        logStall(120_000);
      }
    }, 120_000);
    t1.unref?.();
    t2.unref?.();
    return new Promise<T>((resolve, reject) => {
      const clear = () => {
        settled = true;
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(deadlineTimer);
      };
      const deadlineTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        clear();
        this.logger.error({
          message: `Spanner op exceeded its ${deadlineMs}ms deadline: ${op} — failing the op`,
          obj: { sql: String(sql).slice(0, 200), pool: SpannerDriver.LIVENESS_MONITOR.poolStats() },
        });
        this.recordDeadlineFailure(generation);
        // Deliberately no grpc `code` on this error: the liveness monitor's probe/exit
        // escalation stays owned by genuine grpc errors; hang-shaped death is owned by the
        // recycle counter.
        reject(
          new Error(
            `Spanner op exceeded its ${deadlineMs}ms deadline: ${op} (configure via SpannerConfig.operationDeadlineMs)`
          )
        );
      }, deadlineMs);
      deadlineTimer.unref?.();
      Promise.resolve(promise).then(
        (value) => {
          if (settled) {
            return; // deadline already failed the caller; the library handles the late settle
          }
          clear();
          this.recordOpSuccess(generation);
          resolve(value);
        },
        (error) => {
          if (settled) {
            return;
          }
          clear();
          // A grpc DEADLINE_EXCEEDED (code 4) is the same dead-channel signal arriving via the
          // per-call gRPC deadline — classification for the one counter, not a second path.
          if (error?.code === 4) {
            this.recordDeadlineFailure(generation);
          }
          reject(error);
        }
      );
    });
  }

  // ── Channel-death recycle (one owner for the process-wide client) ─────────

  private recordOpSuccess(generation: number): void {
    if (generation !== SpannerDriver.CLIENT_GENERATION) {
      return; // outcome from a recycled client says nothing about the fresh channel
    }
    SpannerDriver.CONSECUTIVE_DEADLINE_FAILURES = 0;
  }

  private recordDeadlineFailure(generation: number): void {
    if (generation !== SpannerDriver.CLIENT_GENERATION) {
      return;
    }
    SpannerDriver.CONSECUTIVE_DEADLINE_FAILURES += 1;
    if (SpannerDriver.CONSECUTIVE_DEADLINE_FAILURES < this.deadlineFailuresBeforeRecycle()) {
      return;
    }
    // Reset BEFORE recycling: the counter and generation swap happen in this same synchronous
    // frame, so a burst of ops all timing out together triggers exactly one recycle.
    SpannerDriver.CONSECUTIVE_DEADLINE_FAILURES = 0;
    this.recycleClient();
  }

  /**
   * Drop the process-wide Spanner client so the next op builds a fresh client/channel — the
   * categorical cure for a dead gRPC channel (Mac sleep, NAT drop) that deadlines every op.
   * The old liveness monitor is stopped so its probe/exit escalation can't kill the process
   * for a channel we just abandoned; LIVENESS_MONITOR itself stays pointed at it (stopped)
   * until getSpannerDb() installs the new client's monitor, keeping in-flight ops' error
   * paths callable.
   */
  private recycleClient(): void {
    this.logger.error({
      message: `Recycling Spanner client after ${this.deadlineFailuresBeforeRecycle()} consecutive op-deadline failures (dead gRPC channel suspected) — a fresh client/channel will be created on the next op`,
    });
    SpannerDriver.CLIENT_GENERATION += 1;
    const oldMonitor = SpannerDriver.LIVENESS_MONITOR;
    const oldDb = SpannerDriver.SPANNER_DB;
    const oldSpanner = SpannerDriver.SPANNER;
    SpannerDriver.SPANNER = undefined;
    SpannerDriver.SPANNER_INSTANCE = undefined;
    SpannerDriver.SPANNER_DB = undefined;
    oldMonitor?.stop();
    // Best-effort teardown of the old client: session deletes are themselves RPCs on the very
    // channel we believe is dead — the recycle must not depend on them succeeding.
    void oldDb?.close().catch(() => undefined);
    try {
      oldSpanner?.close();
    } catch {
      // already torn down
    }
  }

  private operationDeadlineMs(): number {
    return this.config.operationDeadlineMs ?? 60_000;
  }

  private deadlineFailuresBeforeRecycle(): number {
    return this.config.deadlineFailuresBeforeRecycle ?? 3;
  }

  /**
   * Execute a schema write operation.
   */
  async runUpdateSchema(sql: string): Promise<void> {
    const startTime = process.hrtime.bigint();
    try {
      this.logger.debug({ message: `Executing schema update`, obj: { sql } });
      const [operation] = await this.getSpannerDb().updateSchema(sql);
      await operation.promise();
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.debug({ message: `Schema update executed`, obj: { sql, durationMs } });
    } catch (error: any) {
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.error({
        message: `Failed when executing schema update`,
        obj: { sql, errorDetails: error.details, durationMs },
      });
      throw error;
    }
  }
}
