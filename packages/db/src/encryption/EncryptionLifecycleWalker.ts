import { QueryBuilder } from '@proteinjs/db-query';
import { Logger } from '@proteinjs/logger';
import type { Table } from '../Table';
import { EncryptedColumns } from './EncryptedColumns';
import { EncryptionEnvelope } from './EncryptionEnvelope';
import { DataKeyStore } from './DataKeyStore';

/**
 * The config-lifecycle transitions, all riding this one walker:
 * - `encrypt` — plaintext → `encrypted: {...}` adoption: rewrite rows whose stored value is
 *   not yet an envelope (also how the initial adoption wave lands).
 * - `retokenize` — a `searchable`/`sortKey` capability added later: rewrite every non-null
 *   value so the write seam derives the new companions/tokens.
 * - `decrypt` — `encrypted` → `false` (a deliberate, reviewed reclassification): rewrite
 *   rows whose stored value is still an envelope; pass the affected columns explicitly
 *   (the config no longer marks them). Stale token rows are swept.
 * - `rotate-keys` — after `DataKeyStore.rotateKey`: rewrite rows whose envelope names an
 *   older version (plaintext stragglers are encrypted too), then the caller retires the old
 *   version.
 */
export type EncryptionWalkMode = 'encrypt' | 'retokenize' | 'decrypt' | 'rotate-keys';

export interface EncryptionWalkSummary {
  scanned: number;
  rewritten: number;
}

export interface EncryptionWalkOptions {
  /**
   * Column property names to walk. Required for mode 'decrypt' (the config no longer marks
   * the columns); defaults to every encrypted-declared column otherwise.
   */
  columns?: string[];
  /** Resume after this row id (the walk is id-ordered; re-running from the start is also safe — done rows are skipped). */
  startAfterId?: string;
  windowSize?: number;
  /** The driver to scan with; defaults to the process's default driver. */
  dbDriver?: import('../Db').DbDriver;
  /** The Db to rewrite through (must be a SYSTEM db); defaults to `getDbAsSystem()`. */
  db?: import('../Db').Db<any>;
}

/**
 * The reusable ONLINE backfill behind every encrypted-column config transition (and key
 * rotation) — the migration-runner pattern: a server-side, id-ordered, windowed table walk
 * that rewrites pending rows THROUGH the normal write seam (so encryption, companions, and
 * search tokens all derive exactly as a live write would).
 *
 * Idempotent and resumable by construction: pending-ness is detected from the stored value
 * itself (envelope or not, version current or not), so a re-run — after a crash, or just to
 * be sure — skips completed rows and continues. Rows written by live traffic mid-walk are
 * already in the new shape and skip too. Run it from a `Migration.run()` for deploy-coupled
 * transitions.
 */
export class EncryptionLifecycleWalker {
  private static readonly DEFAULT_WINDOW_SIZE = 200;
  private logger = new Logger({ name: this.constructor.name });
  private encryptedColumns = new EncryptedColumns();
  private envelope = new EncryptionEnvelope();

  async walkTable(
    table: Table<any>,
    mode: EncryptionWalkMode,
    options: EncryptionWalkOptions = {}
  ): Promise<EncryptionWalkSummary> {
    this.encryptedColumns.ensureSchema(table);
    const props = this.resolveProps(table, mode, options);
    const { Db, getDbAsSystem } = await import('../Db');
    const dbDriver = options.dbDriver ?? Db.getDefaultDbDriver();
    // Every mode rewrites how rows are STORED, never what they say — a content-preserving
    // rewrite by definition: `updated` stays as found and the content-derived watchers
    // (recency, mirrors, change notifications) stay silent, while encryption, companions, and
    // tokens re-derive exactly as a live write would. See ContentPreservingRewrite.
    const db = (options.db ?? getDbAsSystem()).asContentPreservingRewrite();
    const windowSize = options.windowSize ?? EncryptionLifecycleWalker.DEFAULT_WINDOW_SIZE;
    const columnNames = props.map((prop) => ({
      prop,
      columnName: ((table.columns as any)[prop] as { name: string }).name,
    }));
    const activeVersionByOwner = new Map<string, number>();

    const summary: EncryptionWalkSummary = { scanned: 0, rewritten: 0 };
    let cursor = options.startAfterId;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rawRows = await this.rawWindow(table, dbDriver, columnNames, cursor, windowSize);
      if (rawRows.length === 0) {
        break;
      }

      for (const rawRow of rawRows) {
        summary.scanned++;
        const pendingProps: string[] = [];
        for (const { prop, columnName } of columnNames) {
          if (await this.isPending(mode, rawRow[columnName], activeVersionByOwner)) {
            pendingProps.push(prop);
          }
        }

        if (pendingProps.length === 0) {
          continue;
        }

        await this.rewriteRow(table, db, rawRow['id'], pendingProps);
        summary.rewritten++;
      }

      cursor = rawRows[rawRows.length - 1]['id'];
      if (rawRows.length < windowSize) {
        break;
      }
    }

    if (mode === 'decrypt') {
      await this.sweepTokenRows(
        table,
        db,
        columnNames.map(({ columnName }) => columnName)
      );
    }

    this.logger.info({
      message: `Encryption lifecycle walk finished`,
      obj: { table: table.name, mode, ...summary },
    });
    return summary;
  }

  private async isPending(
    mode: EncryptionWalkMode,
    rawValue: any,
    activeVersionByOwner: Map<string, number>
  ): Promise<boolean> {
    if (rawValue === null || typeof rawValue === 'undefined') {
      return false;
    }

    const parsed = this.envelope.parse(rawValue);
    switch (mode) {
      case 'encrypt':
        return !parsed;
      case 'retokenize':
        return true;
      case 'decrypt':
        return !!parsed;
      case 'rotate-keys': {
        if (!parsed) {
          return true; // plaintext straggler — encrypt under the current key
        }
        let activeVersion = activeVersionByOwner.get(parsed.owner);
        if (typeof activeVersion === 'undefined') {
          activeVersion = (await new DataKeyStore().getWriteKey(parsed.owner)).version;
          activeVersionByOwner.set(parsed.owner, activeVersion);
        }
        return parsed.version < activeVersion;
      }
    }
  }

  /**
   * Rewrite one row through the normal seam: read it (the deserialize hook decrypts — or
   * passes plaintext through, the adoption path), write the pending columns back (the
   * serialize hook re-derives ciphertext, companions, and tokens under the current config).
   */
  private async rewriteRow(
    table: Table<any>,
    db: import('../Db').Db<any>,
    id: string,
    pendingProps: string[]
  ): Promise<void> {
    const row = await db.get(table, { id });
    if (!row) {
      return; // deleted mid-walk
    }

    const payload: any = { id };
    for (const prop of pendingProps) {
      if (typeof row[prop] !== 'undefined') {
        payload[prop] = row[prop];
      }
    }

    if (Object.keys(payload).length === 1) {
      return;
    }

    await db.update(table, payload);
  }

  /** Raw (un-deserialized) id-ordered window — pending-ness must see stored bytes, not decrypted values. */
  private async rawWindow(
    table: Table<any>,
    dbDriver: import('../Db').DbDriver,
    columnNames: { prop: string; columnName: string }[],
    cursor: string | undefined,
    windowSize: number
  ): Promise<any[]> {
    const { StatementConfigFactory } = await import('../StatementConfigFactory');
    const statementConfigFactory = new StatementConfigFactory(dbDriver.getDbName());
    const qb = new QueryBuilder(table.name).select({ fields: ['id', ...columnNames.map(({ prop }) => prop)] });
    if (cursor) {
      qb.condition({ field: 'id', operator: '>', value: cursor });
    }
    qb.sort([{ field: 'id' }]).paginate({ start: 0, end: windowSize });
    return await dbDriver.runQuery((config) => qb.toSql(statementConfigFactory.getStatementConfig(config)));
  }

  /** After decrypt-out, the decrypted columns' token rows are stale — sweep them. */
  private async sweepTokenRows(table: Table<any>, db: import('../Db').Db<any>, columnNames: string[]): Promise<void> {
    const tokenTable = this.encryptedColumns.tokenTableFor(table) ?? this.encryptedColumns.tokenTableShape(table);
    if (!(await db.tableExists(tokenTable))) {
      return;
    }

    const deleteQb = new QueryBuilder(tokenTable.name).condition({
      field: 'columnName',
      operator: 'IN',
      value: columnNames,
    });
    await db.delete(tokenTable, deleteQb);
  }

  private resolveProps(table: Table<any>, mode: EncryptionWalkMode, options: EncryptionWalkOptions): string[] {
    if (options.columns && options.columns.length > 0) {
      for (const prop of options.columns) {
        if (!(table.columns as any)[prop]) {
          throw new Error(`(${table.name}) Unknown column property to walk: ${prop}`);
        }
      }
      return options.columns;
    }

    if (mode === 'decrypt') {
      throw new Error(
        `Mode 'decrypt' requires options.columns: after the config flips to encrypted: false, the ` +
          `declaration no longer names the columns to decrypt.`
      );
    }

    const props = this.encryptedColumns.encryptedProps(table);
    if (props.length === 0) {
      throw new Error(`(${table.name}) No encrypted columns declared — nothing to walk.`);
    }

    return props;
  }
}
