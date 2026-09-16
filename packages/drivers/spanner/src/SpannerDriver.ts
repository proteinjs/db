import { Database, Instance, Spanner, SpannerOptions, Transaction } from '@google-cloud/spanner';
import { SessionPoolOptions } from '@google-cloud/spanner/build/src/session-pool';
import { DeadlineError } from '@google-cloud/spanner/build/src/transaction-runner';
import {
  DbDriver,
  DbDriverQueryStatementConfig,
  DbDriverDmlStatementConfig,
  Table,
  TableManager,
  tableByName,
} from '@proteinjs/db';
import { SpannerConfig } from './SpannerConfig';
import { SpannerEnvTokenAuth, SpannerEnvTokenAuthError, SPANNER_ENV_TOKEN_VAR } from './SpannerEnvTokenAuth';
import { SpannerOperationError, SpannerOperationKind } from './SpannerOperationError';
import { SpannerLivenessMonitor, type SpannerSessionPoolStats } from './SpannerLivenessMonitor';
import { Logger } from '@proteinjs/logger';
import { ParamType, Statement } from '@proteinjs/db-query';
import { SpannerSchemaOperations } from './SpannerSchemaOperations';
import { SpannerColumnTypeFactory } from './SpannerColumnTypeFactory';
import { SpannerSchemaMetadata } from './SpannerSchemaMetadata';

/**
 * Google Spanner driver for ProteinJs Db
 */
export class SpannerDriver implements DbDriver {
  private static SPANNER?: Spanner;
  /** Set iff the process-wide client was built on an env-delivered token (see envTokenAuthOverride). */
  private static ENV_TOKEN_AUTH?: SpannerEnvTokenAuth;
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
  /**
   * The default wall-clock budget the client library's transaction runner re-runs an aborted
   * `runTransactionAsync` body within — the library's own default, made explicit so the budget the
   * driver runs under is visible in one place. `SpannerConfig.transactionRetryTimeoutMs` overrides
   * it (see transactionRetryTimeoutMs()); a budget that runs out surfaces as the runner's
   * DeadlineError carrying the last abort (see runRetriedTransaction).
   */
  private static readonly DEFAULT_TRANSACTION_RETRY_TIMEOUT_MS = 3_600_000;
  /**
   * The attempt number of every transaction the runner currently drives, keyed by that attempt's
   * transaction handle — how the failure path (operationFailure) knows a statement ran inside a
   * runner-driven transaction, and which attempt it was. Process-wide like the Database the
   * transactions come from; an entry dies with its handle.
   */
  private static readonly RUNNER_ATTEMPTS = new WeakMap<Transaction, number>();
  private logger = new Logger({ name: this.constructor.name });
  private config: SpannerConfig;
  public getTable: ((name: string) => Table<any>) | undefined;

  constructor(config: SpannerConfig, getTable?: (name: string) => Table<any>) {
    this.config = config;
    this.getTable = getTable;
  }

  /**
   * The session-pool gauge (P4a), read-only — the five numbers that make pool exhaustion
   * observable, for external observers (the ops monitors platform). `borrowed` counts sessions
   * genuinely checked out; in-flight creations are reported separately as `pending` (see
   * SpannerSessionPoolStats). Undefined until the process has connected a Database (no pool
   * exists to gauge yet).
   */
  static getSessionPoolStats(): SpannerSessionPoolStats | undefined {
    if (!SpannerDriver.SPANNER_DB) {
      return undefined;
    }
    return SpannerDriver.LIVENESS_MONITOR.poolStats();
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
        // Env-delivered token auth (the sandbox dev-server leg): with CLOUDSDK_AUTH_ACCESS_TOKEN
        // present, the client is built on that bearer token via the vendor's auth override —
        // see envTokenAuthOverride(). Absent, the merge below is exactly the ADC construction it
        // always was; explicit spannerOptions still win the merge, unchanged.
        SpannerDriver.SPANNER = new Spanner(
          Object.assign(
            { projectId: this.config.projectId },
            keepalive,
            this.envTokenAuthOverride(),
            this.config.spannerOptions
          )
        );
      } else {
        SpannerDriver.SPANNER = new Spanner(
          Object.assign({ projectId: this.config.projectId }, keepalive, this.envTokenAuthOverride())
        );
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
      // The pool hangs off the Database handle: `database()`'s second argument is where pool
      // options enter (the Spanner client constructor carries none) — see sessionPoolOptions().
      SpannerDriver.SPANNER_DB = this.getSpannerInstance().database(
        this.config.databaseName,
        this.sessionPoolOptions()
      );
      // The monitor's start() is also the Database's one 'error'-channel owner (the session
      // pool forwards its errors to the Database emitter; unlistened, Node's unhandled-'error'
      // crash takes the process down). It stays attached through recycle — a stopped monitor
      // swallows the abandoned client's teardown errors.
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

    await this.createDb(this.getDbName());
  }

  /**
   * Create the named database in one operation. `ddl` statements ride the create as
   * `CreateDatabase.extra_statements` — applied in order, atomically with the creation (if any
   * statement fails, the database is not created) — so a database can be born with its full
   * schema without a second schema-update operation.
   */
  async createDb(name: string, options?: { ddl?: string[] }): Promise<void> {
    const [database, operation] = await this.getSpannerInstance().createDatabase(name, {
      extraStatements: options?.ddl ?? [],
      // Admin-handle hygiene (see adminDbHandle): the client constructs the returned handle
      // BEFORE the create operation completes — a default eager pool races the operation and
      // crashes on NOT_FOUND.
      poolOptions: { min: 0 },
    });
    database.on('error', () => undefined);
    await operation.promise();
    await database.close().catch(() => undefined);
  }

  /** Drop the named database (client `Database.delete()` — closes the handle, then drops). */
  async dropDb(name: string): Promise<void> {
    await this.adminDbHandle(name).delete();
  }

  async dbExists(databaseName: string): Promise<boolean> {
    const database = this.adminDbHandle(databaseName);
    try {
      const [exists] = await database.exists();
      return exists;
    } finally {
      await database.close().catch(() => undefined);
    }
  }

  /**
   * A Database handle for admin operations (exists/drop): admin RPCs ride the admin client, not
   * sessions, so the pool is configured to hold ZERO sessions — the default pool eagerly fills
   * in the handle's constructor and emits process-crashing unlistened 'error' events when the
   * database does not exist, which is the NORMAL case for these operations. Its error channel is
   * owned for the same reason.
   */
  private adminDbHandle(name: string): Database {
    const database = this.getSpannerInstance().database(name, { min: 0 });
    database.on('error', () => undefined);
    return database;
  }

  /**
   * Execute a query.
   */
  async runQuery(
    generateStatement: (config: DbDriverQueryStatementConfig) => Statement,
    transaction?: Transaction
  ): Promise<any[]> {
    const callSiteStack = this.callSiteStack(this.runQuery);
    return await this.executeQuery(generateStatement, transaction || this.getSpannerDb(), callSiteStack);
  }

  private async executeQuery(
    generateStatement: (config: DbDriverQueryStatementConfig) => Statement,
    runner: Database | Transaction,
    callSiteStack?: string
  ): Promise<any[]> {
    const { sql, namedParams } = generateStatement({
      useParams: true,
      useNamedParams: true,
      prefixTablesWithDb: false,
      getDriverColumnType: this.getColumnType.bind(this),
      handleCaseSensitivity: this.handleCaseSensitivity.bind(this),
      // GoogleSQL day/hour/minute truncation for QueryBuilder.timeBucket. UTC deliberately:
      // bucket boundaries must be stable regardless of the serving process's TZ (hour/minute-grain
      // callers render the UTC buckets in the operator's local time).
      dateTruncExpression: (resolvedColumnName: string, unit: 'day' | 'hour' | 'minute') =>
        `TIMESTAMP_TRUNC(${resolvedColumnName}, ${unit === 'minute' ? 'MINUTE' : unit === 'hour' ? 'HOUR' : 'DAY'}, 'UTC')`,
      paramExpression: this.paramExpression,
    });

    const startTime = process.hrtime.bigint();

    try {
      this.logger.debug({ message: `Executing query`, obj: { sql, params: namedParams } });
      const wire = this.wireParams(namedParams);
      const [rows] = await this.withDeadline(
        'spanner query',
        sql,
        runner.run({
          sql,
          params: wire.params,
          types: wire.types,
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
      throw this.operationFailure('query', sql, error, durationMs, callSiteStack, runner);
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
    const callSiteStack = this.callSiteStack(this.runDml);
    if (transaction) {
      return await this.executeDml(generateStatement, transaction, callSiteStack);
    }

    // A single-statement transaction of its own, under the runner (see runRetriedTransaction).
    return await this.runRetriedTransaction('spanner dml transaction', (transaction) =>
      this.executeDml(generateStatement, transaction, callSiteStack)
    );
  }

  private async executeDml(
    generateStatement: (config: DbDriverDmlStatementConfig) => Statement,
    runner: Transaction,
    callSiteStack?: string
  ): Promise<number> {
    const { sql, namedParams } = generateStatement({
      useParams: true,
      useNamedParams: true,
      prefixTablesWithDb: false,
      getDriverColumnType: this.getColumnType.bind(this),
      paramExpression: this.paramExpression,
    });

    const startTime = process.hrtime.bigint();

    try {
      this.logger.debug({ message: `Executing dml`, obj: { sql, params: namedParams } });
      // DML rides the unary ExecuteBatchDml RPC (`batchUpdate`), never streaming `runUpdate`
      // (ExecuteStreamingSql). The client's streaming transport TRANSPARENTLY RE-SENDS a DML
      // whose response was lost: gax wraps every server-streaming call in retry-request, which
      // silently replays on ANY pre-response error. Seqno replay protection only covers the
      // same-transaction geometry; the geometries it cannot cover are where the 2026-08-13
      // splice incident lived — an inline-begin replay BEGINS A FRESH TRANSACTION per attempt
      // (abandoned applied-but-uncommitted siblings churn locks and collide with rows committed
      // by other paths: spurious `6 ALREADY_EXISTS` under pool pressure), and the stream-
      // resumption layer re-mints a NEW seqno into the SAME transaction after inline-begin
      // learned its id (unprotected even on real Spanner). The unary RPC has none of that
      // machinery — see dmlGaxOptions() for the per-backend retry policy on it.
      const wire = this.wireParams(namedParams);
      const [rowCounts] = await this.withDeadline(
        'spanner dml',
        sql,
        runner.batchUpdate([{ sql, params: wire.params, types: wire.types }], {
          gaxOptions: this.dmlGaxOptions(),
        })
      );
      const rowCount = rowCounts[0] ?? 0;
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.debug({
        message: `Dml executed`,
        obj: { sql, durationMs, rowCount },
      });
      return rowCount;
    } catch (error: any) {
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      throw this.operationFailure('dml', sql, error, durationMs, callSiteStack, runner);
    }
  }

  /**
   * A data op's failure, logged ONCE with its cause and rethrown as the driver's typed error
   * (`SpannerOperationError`: the vendor error as `cause`, its gRPC `code` copied, the CALLER's
   * stack). The log line names what actually failed — the underlying status and message, the
   * statement's verb and table, the duration — and never the bound values: those ride the DEBUG
   * line beside the op only. A rejection that is already one of the driver's own typed errors (the
   * env-token auth translation, an earlier wrap) is logged the same way and passes through as is.
   *
   * A statement ABORTED (gRPC code 10) inside a transaction the runner drives is not a failure
   * but the runner's retry signal — Spanner's wound-wait aborted the loser of a lock conflict at
   * its statement, and the runner re-runs the body on a fresh transaction (runRetriedTransaction)
   * — so it is logged at debug with its attempt number, never at error, and never reported to the
   * liveness monitor; retriedAbort is the one classification. The typed error still carries the
   * code: the body rethrows it, and the runner's retry keys on exactly that.
   */
  private operationFailure(
    operation: SpannerOperationKind,
    sql: string,
    error: unknown,
    durationMs: number,
    callSiteStack: string | undefined,
    runner: Database | Transaction
  ): Error {
    const statement = SpannerOperationError.statementShape(sql);
    const failure =
      error instanceof SpannerOperationError || error instanceof SpannerEnvTokenAuthError
        ? error
        : new SpannerOperationError(operation, statement, error, callSiteStack);
    const retried = this.retriedAbort(runner, error);
    if (retried) {
      this.logger.debug({
        message: `Transaction aborted at ${operation}; the transaction runner retries it`,
        obj: { attempt: retried.attempt, statement, cause: SpannerOperationError.summarize(error), sql, durationMs },
      });
      return failure;
    }
    this.logger.error({
      message: `Failed when executing ${operation}`,
      error: failure,
      obj: {
        statement,
        cause: SpannerOperationError.summarize(error),
        sql,
        durationMs,
      },
    });
    SpannerDriver.LIVENESS_MONITOR.reportError(error);
    return failure;
  }

  /**
   * The one classification of a retried abort: the statement ran on a transaction the runner
   * drives (marked with its attempt by runRetriedTransaction) and the backend answered ABORTED
   * (gRPC code 10) — the code the runner retries. Any other rejection, and an ABORTED on a
   * transaction nobody retries (a caller-managed handle, a single-use read), is a failure.
   */
  private retriedAbort(runner: Database | Transaction, error: unknown): { attempt: number } | undefined {
    const attempt = SpannerDriver.RUNNER_ATTEMPTS.get(runner as Transaction);
    if (attempt === undefined || (error as { code?: unknown } | null | undefined)?.code !== 10) {
      return undefined;
    }
    return { attempt };
  }

  /**
   * The caller's frames at a public door (`runQuery` / `runDml`), captured synchronously on entry —
   * before the vendor client's own frames take over — so a failure's stack locates the code that
   * issued the statement (as far as the callers' compile targets let V8 walk the await chain).
   */
  private callSiteStack(door: Function): string | undefined {
    const holder: { stack?: string } = {};
    Error.captureStackTrace(holder, door);
    const frames = holder.stack?.replace(/^Error\n?/, '');
    return frames || undefined;
  }

  /**
   * Execute a transaction.
   * @param fn all db operations within this function will be part of this transaction
   * @returns the return of the `fn`
   */
  async runTransaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    return await this.runRetriedTransaction('spanner transaction', fn);
  }

  /**
   * One read-write transaction under the client library's runner, committed on success and
   * rolled back on failure — the shape both `runTransaction` and the single-statement `runDml`
   * ride. Every await inside the run function is deadline-bounded (statements, commit, rollback):
   * the run function therefore ALWAYS settles, which is what makes runTransactionAsync's own
   * `finally` release the transaction's session back to the pool on a dead channel. Stalls in the
   * wrapper itself (session acquisition / begin / commit) happen OUTSIDE the statements'
   * instrumentation, so the whole round trip is deadline-wrapped too.
   *
   * The runner RETRIES an aborted attempt (transactionRetryTimeoutMs()): the body runs again on a
   * fresh transaction, and the abort that ended the previous attempt was a retry signal, not a
   * failure — each attempt's transaction is marked with its attempt number so the failure path
   * logs that abort at debug (operationFailure via retriedAbort). Only the runner giving up — its
   * budget spent, thrown as its DeadlineError carrying the last abort — is the failure, logged
   * here at error with that cause, once.
   */
  private async runRetriedTransaction<T>(op: string, fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    let attempt = 0;
    const budgetMs = this.transactionRetryTimeoutMs();
    const startTime = process.hrtime.bigint();
    try {
      return await this.withDeadline(
        op,
        '(runTransactionAsync)',
        this.getSpannerDb().runTransactionAsync({ timeout: budgetMs }, async (transaction) => {
          attempt += 1;
          SpannerDriver.RUNNER_ATTEMPTS.set(transaction, attempt);
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
    } catch (error) {
      if (error instanceof DeadlineError) {
        const lastAbort: unknown = error.errors[0];
        this.logger.error({
          message: `Transaction retry budget exhausted: ${op}`,
          error,
          obj: {
            attempts: attempt,
            budgetMs,
            statement: lastAbort instanceof SpannerOperationError ? lastAbort.statement : undefined,
            cause: SpannerOperationError.summarize(lastAbort),
            durationMs: Number(process.hrtime.bigint() - startTime) / 1_000_000,
          },
        });
      }
      throw error;
    }
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
          // Every query/dml/transaction op rejects through here, so this is the one place
          // env-token auth failures (UNAUTHENTICATED) become the typed rotation error.
          reject(this.translateAuthFailure(error));
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
   * Auth selection for the process-wide client, evaluated once per client construction:
   *
   * - `SPANNER_EMULATOR_HOST` set → no override. The vendor short-circuits auth ENTIRELY on
   *   the emulator path: it swaps in insecure channel credentials, and google-gax returns
   *   those before ever consulting auth (`GrpcClient._getCredentials`: `if (opts.sslCreds)
   *   return opts.sslCreds`) — so emulator construction stays byte-identical to before.
   * - `CLOUDSDK_AUTH_ACCESS_TOKEN` set → the env-token auth client (see SpannerEnvTokenAuth):
   *   the control-plane-minted bearer token authenticates every RPC; expiry re-reads the env /
   *   invokes `SpannerConfig.envTokenRefreshHook`; a dead token is a loud
   *   `SpannerEnvTokenAuthError`, never a silent fall-back to ADC.
   * - neither → no override; the client resolves application-default credentials exactly as it
   *   always has.
   *
   * The selection never changes mid-client: recycleClient() clears ENV_TOKEN_AUTH so only a
   * FRESH client re-selects.
   */
  private envTokenAuthOverride(): { authClient?: NonNullable<SpannerOptions['authClient']> } {
    SpannerDriver.ENV_TOKEN_AUTH = undefined;
    if (process.env.SPANNER_EMULATOR_HOST || !SpannerEnvTokenAuth.envTokenPresent()) {
      return {};
    }
    this.logger.info({
      message: `Spanner auth: env-delivered access token (${SPANNER_ENV_TOKEN_VAR}) — application-default credentials are not consulted`,
    });
    SpannerDriver.ENV_TOKEN_AUTH = new SpannerEnvTokenAuth(this.config.envTokenRefreshHook);
    // GoogleAuth caches any AuthClient verbatim (`cachedCredential = opts.authClient`) and
    // google-gax only ever duck-types it (createFromGoogleCredential → getRequestHeaders); the
    // TS surface narrows `authClient` to JSONClient, hence the one cast at this boundary.
    return {
      authClient: SpannerDriver.ENV_TOKEN_AUTH.authClient as unknown as NonNullable<SpannerOptions['authClient']>,
    };
  }

  /**
   * The env-token auth failure grammar: a grpc UNAUTHENTICATED (code 16) while the client runs
   * on an env-delivered token means the token died before its rotation reached us. The cached
   * token is dropped so the NEXT op re-mints (re-reads the env / re-invokes the refresh hook),
   * and the failure surfaces as a typed error naming the rotation path. Deliberately NO
   * fallback to application-default credentials: silently switching identities would hide that
   * rotation is due and change what the process can reach. ADC mode is untouched — without an
   * active env-token auth, every error passes through unchanged.
   */
  private translateAuthFailure(error: any): any {
    if (error?.code !== 16 || !SpannerDriver.ENV_TOKEN_AUTH) {
      return error;
    }
    SpannerDriver.ENV_TOKEN_AUTH.invalidate();
    return new SpannerEnvTokenAuthError(
      `Spanner rejected the env-delivered access token (${SPANNER_ENV_TOKEN_VAR}): ${error.message}. The token has ` +
        `likely expired; the driver dropped it and will re-read the env / re-invoke SpannerConfig.envTokenRefreshHook ` +
        `on the next op. Rotate the token (re-configure the runtime env and restart, or provide envTokenRefreshHook); ` +
        `the driver never falls back to application-default credentials.`,
      error
    );
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
    SpannerDriver.ENV_TOKEN_AUTH = undefined; // the fresh client re-runs auth selection
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

  /**
   * Per-call gax options for the DML RPC (ExecuteBatchDml). The gRPC deadline (see runDml)
   * applies everywhere. The transparent-retry policy differs by backend:
   *
   * - Real Spanner: gax's default unary policy (UNAVAILABLE only) stands. A replay re-sends the
   *   identical request — same seqno, deduped in the same-transaction geometry — and in the
   *   inline-begin geometry only the transaction the client ultimately commits applies durably,
   *   so the transient-blip resilience is safe there.
   * - Emulator (SPANNER_EMULATOR_HOST — the same switch the client library keys on): a replayed
   *   inline-begin DML begins a fresh transaction per attempt, and the abandoned
   *   applied-but-uncommitted siblings are exactly what fed the splice incident's spurious
   *   failures under pool pressure. `retry: null` makes the call single-attempt: a lost response
   *   surfaces as the loss to the caller, deterministically, instead of invisible multi-
   *   transaction churn. Loopback needs no blip resilience.
   */
  private dmlGaxOptions(): { timeout: number; retry?: null } {
    const gaxOptions: { timeout: number; retry?: null } = { timeout: this.operationDeadlineMs() };
    if (process.env.SPANNER_EMULATOR_HOST) {
      gaxOptions.retry = null;
    }
    return gaxOptions;
  }

  /**
   * Session-pool options for the process-wide Database handle (`Instance.database()`'s second
   * argument — the only place pool options enter; the Spanner client constructor carries none).
   * An explicit `SpannerConfig.sessionPoolOptions` is the contract and always wins. Otherwise,
   * by backend:
   *
   * - Real Spanner: the vendor's defaults stand (`min: 25, incStep: 25` — an eager 25-session
   *   fill in the handle's constructor, growth in steps of 25). Production's pool is untouched.
   * - Emulator (SPANNER_EMULATOR_HOST — the same switch the client library keys on): sessions on
   *   demand, `min: 0, incStep: 1`. The emulator is local and single-tenant, and the FILL is the
   *   cost, not the sessions: every fresh Database pays a 25-session BatchCreateSessions burst on
   *   its first op, and jest's per-file module registry gives each suite a fresh driver — a
   *   340-suite package paid it ~340 times, the bursts contending under two workers until a
   *   suite's first op tripped its 60 s timeout (flow, 2026-09-05), and the emulator never reaps
   *   the 25 sessions each suite leaves behind. A suite peaks at one or two sessions; it gets
   *   them when it asks.
   */
  private sessionPoolOptions(): SessionPoolOptions | undefined {
    if (this.config.sessionPoolOptions) {
      return this.config.sessionPoolOptions;
    }
    if (process.env.SPANNER_EMULATOR_HOST) {
      return { min: 0, incStep: 1 };
    }
    return undefined;
  }

  private operationDeadlineMs(): number {
    return this.config.operationDeadlineMs ?? 60_000;
  }

  private transactionRetryTimeoutMs(): number {
    return this.config.transactionRetryTimeoutMs ?? SpannerDriver.DEFAULT_TRANSACTION_RETRY_TIMEOUT_MS;
  }

  private deadlineFailuresBeforeRecycle(): number {
    return this.config.deadlineFailuresBeforeRecycle ?? 3;
  }

  /**
   * Bind-boundary typing, the SQL half (the wire half is wireParams()). A JSON column binds as
   * `PARSE_JSON(@p, wide_number_mode=>'round')` over a STRING param, never as a JSON-typed param:
   * Spanner parses a JSON-typed param in its default `exact` mode and refuses any number whose
   * text does not survive its own float64 canonicalization — ordinary shortest-form doubles
   * included (`0.915908`, `297.3344693281405`; their 17-digit forms are refused too), so no
   * client-side rendering is guaranteed to pass and the write fails with OUT_OF_RANGE "Input
   * number: 0.915908 cannot round-trip through string representation". `'round'` is the vendor's
   * documented remedy: Spanner stores the nearest float64 and renders it back with up to 17
   * significant digits, which parses to the identical JS double — the value round-trips exactly
   * through the client. The emulator enforces the rule on JSON literals and on PARSE_JSON, not on
   * JSON-typed params (JsonParams.test.ts applies it to the wire form by hand).
   */
  private paramExpression = (placeholder: string, type: ParamType): string =>
    type === 'json' ? `PARSE_JSON(${placeholder}, wide_number_mode=>'round')` : placeholder;

  /**
   * Bind-boundary typing, the wire half — every query/dml param passes through here on its way
   * to the client. Typing is categorical: driven by the statement's types map, which carries the
   * COLUMN type (SpannerColumnTypeFactory via getColumnType), never by the value's shape.
   *
   * FLOAT64: the client codec encodes param VALUES by their JS shape, ignoring the declared
   * param type — any integral JS number (`0`, `7`) is stringified into the INT64 wire encoding,
   * which a FLOAT64 column rejects ("Could not parse 0 as a FLOAT64"). `Spanner.float()` is the
   * client's own escape hatch: the codec unwraps it to a raw number, FLOAT64's correct encoding,
   * so `0` and `0.5` bind identically. Scalars and ARRAY<FLOAT64> elements are both wrapped;
   * non-number values (null) pass through untouched.
   *
   * JSON: the value travels as its JSON text in a STRING param — the operand of the PARSE_JSON
   * that paramExpression() stood in for its placeholder — so the param is re-typed `string`.
   * null stays null (PARSE_JSON(NULL) is NULL). The two halves are one binding: a hand-written
   * statement declaring a `json` param renders its placeholder through paramExpression() too.
   */
  private wireParams(namedParams?: Statement['namedParams']): {
    params?: { [param: string]: any };
    types?: { [param: string]: any };
  } {
    // An untyped statement (hand-written generators may carry params with no types map) has
    // nothing to key the typing on — the params pass through exactly as written.
    if (!namedParams?.types) {
      return { params: namedParams?.params, types: namedParams?.types };
    }
    const types: { [param: string]: string | { type: string; child?: { type: string } } } = { ...namedParams.types };
    const params: { [param: string]: any } = { ...namedParams.params };
    for (const [name, type] of Object.entries(types)) {
      const value = params[name];
      if (type === 'float64' && typeof value === 'number') {
        params[name] = Spanner.float(value);
      } else if (type === 'json') {
        params[name] = value === undefined || value === null ? null : JSON.stringify(value);
        types[name] = 'string';
      } else if (
        typeof type === 'object' &&
        type.type === 'array' &&
        type.child?.type === 'float64' &&
        Array.isArray(value)
      ) {
        params[name] = value.map((element) => (typeof element === 'number' ? Spanner.float(element) : element));
      }
    }
    return { params, types };
  }

  /**
   * Execute a schema write operation — one long-running operation for the WHOLE statement list
   * (`UpdateDatabaseDdl` applies the statements in order). Sequential per-statement operations
   * are what made a 37-statement prod boot take 10m31s; callers batch and pass the list.
   *
   * Partial-failure semantics (verified against the emulator; matches Spanner's documented
   * batch-DDL behavior — both phases are covered in BatchedDdl.test.ts):
   * - VALIDATION failure (schema-shape errors, checked upfront for the whole batch, in order,
   *   against the projected schema): the batch is rejected before anything applies — NOTHING
   *   lands. Strictly safer than the old serial path, which stranded the earlier statements.
   * - APPLY failure (data-dependent errors, e.g. a unique-index backfill over duplicate rows):
   *   statements BEFORE the failing one stay applied; the failing one and everything after are
   *   cancelled — the serial path's semantics.
   * Neither phase reports a positional statement index: the backend error names the offending
   * OBJECT (table/index/column). The failure log below carries the full statement list plus
   * that reason, which together locate the statement.
   */
  async runUpdateSchema(statements: string | string[]): Promise<void> {
    const statementList = Array.isArray(statements) ? statements : [statements];
    const startTime = process.hrtime.bigint();
    try {
      this.logger.debug({ message: `Executing schema update`, obj: { statements: statementList } });
      const [operation] = await this.getSpannerDb().updateSchema(statementList);
      await operation.promise();
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.debug({
        message: `Schema update executed`,
        obj: { statementCount: statementList.length, durationMs },
      });
    } catch (error: any) {
      const durationMs = Number(process.hrtime.bigint() - startTime) / 1_000_000;
      this.logger.error({
        message: `Failed when executing schema update`,
        // Apply-phase LRO failures carry their reason only in `message` (`details` is
        // undefined there); validation-phase gRPC errors carry both.
        obj: { statements: statementList, errorDetails: error.details ?? String(error), durationMs },
      });
      // DDL is exempt from withDeadline, so it carries its own env-token auth translation.
      throw this.translateAuthFailure(error);
    }
  }
}
