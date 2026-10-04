import {
  DbDriver,
  DbDriverDmlStatementConfig,
  DbDriverQueryStatementConfig,
  SerializedRecord,
  Statement,
  TableManager,
} from '@proteinjs/db';

/**
 * The real driver, with `writers` concurrent writers held in lockstep at their first write: each
 * writer's first write is held until every writer has reached one, then all run; every later
 * write waits until every first write has settled. The interleaving under which concurrent
 * writers of one fresh name each observe no row before any of them writes one — what two requests
 * produce when they write one setting at the same moment — made exact, so the suite does not
 * rest on timing (the emulator serializes concurrent transactions with aborts and retries, which
 * on their own let one writer's second write slip in before the other's first has settled).
 * Reads go straight through. A barrier that never fills fails the held writers with a named
 * error instead of hanging the suite.
 */
export class HeldFirstWriteDriver implements DbDriver {
  private arrivals = 0;
  private release!: () => void;
  private readonly released: Promise<void>;
  private readonly firstWrites: Promise<void>[] = [];

  constructor(
    private readonly driver: DbDriver,
    private readonly writers: number
  ) {
    this.released = new Promise<void>((resolve, reject) => {
      this.release = resolve;
      setTimeout(
        () => reject(new Error(`Only ${this.arrivals} of ${writers} writers reached their first write`)),
        10000
      ).unref();
    });
  }

  async runDml(
    generateStatement: (config: DbDriverDmlStatementConfig) => Statement,
    transaction?: unknown
  ): Promise<number> {
    if (this.arrivals < this.writers) {
      this.arrivals += 1;
      if (this.arrivals === this.writers) {
        this.release();
      }
      await this.released;
      const write = this.driver.runDml(generateStatement, transaction);
      this.firstWrites.push(
        write.then(
          () => undefined,
          () => undefined
        )
      );
      return await write;
    }
    await Promise.all(this.firstWrites);
    return await this.driver.runDml(generateStatement, transaction);
  }

  runQuery(
    generateStatement: (config: DbDriverQueryStatementConfig) => Statement,
    transaction?: unknown
  ): Promise<SerializedRecord[]> {
    return this.driver.runQuery(generateStatement, transaction);
  }

  runTransaction<T>(fn: (transaction: unknown) => Promise<T>): Promise<T> {
    return this.driver.runTransaction(fn);
  }

  isDuplicateKeyError(error: unknown): boolean {
    return this.driver.isDuplicateKeyError?.(error) ?? false;
  }

  getDbName(): string {
    return this.driver.getDbName();
  }

  createDbIfNotExists(): Promise<void> {
    return this.driver.createDbIfNotExists();
  }

  createDb(name: string, options?: { ddl?: string[] }): Promise<void> {
    return this.driver.createDb(name, options);
  }

  dropDb(name: string): Promise<void> {
    return this.driver.dropDb(name);
  }

  getTableManager(): TableManager {
    return this.driver.getTableManager();
  }

  getOperationDeadlineMs(): number {
    return this.driver.getOperationDeadlineMs();
  }

  /** Forwarded; a driver that declares no bound would leave this undeclared, which a wrapper cannot express. */
  getStatementParameterLimit(): number {
    const limit = this.driver.getStatementParameterLimit?.();
    if (limit === undefined) {
      throw new Error('The wrapped driver declares no statement parameter limit');
    }
    return limit;
  }
}
