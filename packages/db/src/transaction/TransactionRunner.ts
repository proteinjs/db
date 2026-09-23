import { Logger } from '@proteinjs/logger';
import { getDb } from '../Db';
import { Table, tableByName } from '../Table';
import { getDefaultTransactionContextFactory } from './TransactionContextFactory';
import {
  TransactionRunnerService,
  TransactionRunOptions,
  getTransactionRunnerService,
} from '../services/TransactionRunnerService';
import { Operation } from './Transaction';

export const getTransactionRunner = () =>
  typeof self === 'undefined' ? new TransactionRunner() : (getTransactionRunnerService() as TransactionRunner);

/**
 * Runs a client `Transaction`'s operations as one server-side transaction.
 *
 * A write may DECLARE the rows it depends on (`options.afterRows`): rows its operations
 * reference whose own insert may still be in flight when this request arrives — a text update
 * released by a page that was going away while its row's insert was still being served, a child
 * row's insert whose root (its permission source, and the owner grant that commits with the
 * root) is still landing. Without the declaration such a write ran to completion inside the
 * insert's window and matched nothing, silently, or was refused at the door for a grant that was
 * a moment from existing — and the page that could have retried was gone. The server outlives
 * the page: it waits, bounded, for every declared row to exist AND be visible to the caller (a
 * read as the caller sees a row exactly when the caller's grant on its scope has committed),
 * then runs the operations. A row that never appears fails the request with a plain clause.
 */
export class TransactionRunner implements TransactionRunnerService {
  public serviceMetadata = {
    auth: {
      allUsers: true,
    },
  };

  /**
   * The longest a write waits for a declared row, in milliseconds. A dependency's insert lands in
   * hundreds of milliseconds on Spanner; on the emulator, whose concurrent read-write transactions
   * abort and retry with a backoff of seconds, in seconds; on a degraded link (a tethered phone:
   * RPC p50 0.4 s, p90 2.4 s, measured) a root's birth of a few dozen sequential statements takes
   * 13 s — and the writes released behind it by a page that is gone have no second chance. The
   * bound is the ceiling for a row that NEVER comes — the named failure, never a hang — so it sits
   * well above a slow birth; a write that waits here holds one request and a poll, nothing else.
   */
  static readonly ROW_WAIT_BOUND_MS = 30_000;
  private static readonly FIRST_POLL_INTERVAL_MS = 25;
  private static readonly MAX_POLL_INTERVAL_MS = 250;

  private logger = new Logger({ name: this.constructor.name });

  constructor(private rowWaitBoundMs: number = TransactionRunner.ROW_WAIT_BOUND_MS) {}

  async run(ops: Operation<any>[], options?: TransactionRunOptions): Promise<void> {
    const db = getDb();
    const afterRows = options?.afterRows ?? [];
    if (afterRows.length > 0) {
      await this.awaitRows(ops, afterRows);
    }

    await db.runTransaction(async () => {
      for (const op of ops) {
        await (db[op.name] as Function)(...op.args);
      }
    });
  }

  /**
   * Wait, bounded by {@link rowWaitBoundMs}, until every declared row exists and is visible to
   * the caller. Each poll is a single-use strong read outside any transaction, so a commit is
   * seen the moment it lands; the interval starts short and backs off so a dependency landing in
   * hundreds of milliseconds is caught within tens.
   */
  private async awaitRows(ops: Operation<any>[], afterRows: string[]): Promise<void> {
    if (getDefaultTransactionContextFactory()?.getTransactionContext().currentTransaction) {
      throw new Error(
        `TransactionRunner: afterRows cannot be honoured inside an ambient transaction — its reads would see the transaction's own snapshot, never a row committed after it began`
      );
    }

    const tablesById = TransactionRunner.rowsTheOperationsReference(ops);
    const unknown = afterRows.filter((id) => !tablesById.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `TransactionRunner: afterRows names rows none of the operations reference (${unknown.join(', ')}) — the write was not run`
      );
    }

    const db = getDb();
    const started = Date.now();
    const deadline = started + this.rowWaitBoundMs;
    /** Per declared id, the (table, id) rows still absent. */
    let waiting: { id: string; tables: Table<any>[] }[] = afterRows
      .filter((id, index) => afterRows.indexOf(id) === index)
      .map((id) => ({ id, tables: tablesById.get(id)!.slice() }));
    let interval = TransactionRunner.FIRST_POLL_INTERVAL_MS;
    let polls = 0;
    for (;;) {
      polls += 1;
      for (const row of waiting) {
        const stillAbsent: Table<any>[] = [];
        for (const table of row.tables) {
          if (!(await db.get(table, { id: row.id } as any))) {
            stillAbsent.push(table);
          }
        }
        row.tables = stillAbsent;
      }
      waiting = waiting.filter((row) => row.tables.length > 0);
      if (waiting.length === 0) {
        const waitedMs = Date.now() - started;
        // One line when the seam did work (the row landed while this write waited); a row that
        // was already there is the common case and stays quiet.
        const line = { message: `Declared rows present`, obj: { afterRows, waitedMs, polls } };
        if (polls > 1) {
          this.logger.info(line);
        } else {
          this.logger.debug(line);
        }
        return;
      }

      const now = Date.now();
      if (now >= deadline) {
        const absent = waiting.map((row) => row.tables.map((table) => `${table.name}:${row.id}`).join(', ')).join(', ');
        this.logger.warn({
          message: `Declared rows absent at the bound — the write was not run`,
          obj: { absent, waitedMs: now - started, polls },
        });
        throw new Error(
          `TransactionRunner: waited ${this.rowWaitBoundMs} ms for rows this write depends on to exist and be visible to the caller; still absent: ${absent} — the write was not run`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(interval, deadline - now)));
      interval = Math.min(interval * 2, TransactionRunner.MAX_POLL_INTERVAL_MS);
    }
  }

  /**
   * The rows the operations reference, by id → the table(s) they are read from: the permission
   * source a row attaches to (an insert whose `permissionSource` is another row), the row an
   * update / preserving update / membership update / delete targets. The rows the operations
   * insert themselves are not dependencies.
   */
  private static rowsTheOperationsReference(ops: Operation<any>[]): Map<string, Table<any>[]> {
    const inserted: string[] = [];
    const referenced = new Map<string, Table<any>[]>();
    const reference = (table: Table<any> | undefined, id: unknown) => {
      if (!table || typeof id !== 'string') {
        return;
      }
      let tables = referenced.get(id);
      if (!tables) {
        tables = [];
        referenced.set(id, tables);
      }
      if (tables.indexOf(table) === -1) {
        tables.push(table);
      }
    };

    for (const op of ops) {
      const args = op.args as unknown[];
      const table = args[0] as Table<any> | undefined;
      if (op.name === 'insert') {
        const record = args[1] as
          | { id?: string; permissionSource?: { _table?: string; _id?: string }; permissionSourceTable?: string }
          | undefined;
        if (record?.id) {
          inserted.push(record.id);
        }
        const source = record?.permissionSource;
        if (source?._id && source._id !== record?.id) {
          const sourceTableName = record?.permissionSourceTable ?? source._table;
          reference(sourceTableName ? TransactionRunner.tableNamed(sourceTableName, table) : table, source._id);
        }
      } else if (op.name === 'update' || op.name === 'updatePreserving') {
        const record = args[1] as { id?: string } | undefined;
        const query = args[2] as { id?: unknown } | undefined;
        reference(table, record?.id ?? (query && typeof query === 'object' && 'id' in query ? query.id : undefined));
      } else if (op.name === 'updateArrayMembership') {
        reference(table, (args[1] as { recordId?: string } | undefined)?.recordId);
      } else if (op.name === 'delete') {
        const query = args[1] as { id?: unknown } | undefined;
        reference(table, query && typeof query === 'object' ? query.id : undefined);
      }
    }

    inserted.forEach((id) => referenced.delete(id));
    return referenced;
  }

  /** The table a permission source lives in: the insert's own table when it names the same one. */
  private static tableNamed(tableName: string, inserting: Table<any> | undefined): Table<any> {
    return inserting && inserting.name === tableName ? inserting : tableByName(tableName);
  }
}
