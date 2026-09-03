import { QueryBuilder } from '@proteinjs/db-query';
import { Logger } from '@proteinjs/logger';
import type { Table } from '../Table';
import { FieldSerializer } from '../Record';
import { EncryptedColumns } from './EncryptedColumns';
import { EncryptionEnvelope } from './EncryptionEnvelope';
import { DataKeyStore } from './DataKeyStore';
import { LeafEnvelopeCodec } from './LeafEnvelopeCodec';
import { ALL_STRINGS_CONTENT, LeafPolicy } from './LeafPolicy';

/**
 * The config-lifecycle transitions, all riding this one walker:
 * - `encrypt` — plaintext → `encrypted: {...}` adoption: rewrite rows whose stored value is
 *   not yet an envelope (also how the initial adoption wave lands). For a leaf-encrypted JSON
 *   column: rows with any CONTENT node still plaintext, or any envelope at a path the current
 *   policy calls metadata — the rewrite converges the document on the current policy in both
 *   directions (a declared policy change is the reviewed act; the walk merely lands it).
 * - `retokenize` — a `searchable`/`sortKey` capability added later: rewrite every non-null
 *   value so the write seam derives the new companions/tokens.
 * - `decrypt` — `encrypted` → `false` (a deliberate, reviewed reclassification; the encryption
 *   rollback act): rewrite rows whose stored value still carries an envelope (any leaf, for JSON
 *   columns), writing PLAINTEXT through the seam regardless of the live declaration
 *   (`Db.asDecryptOut`) — so the walk cannot re-encrypt behind itself on the live build. Pass
 *   the affected columns explicitly (a flipped config no longer marks them). Stale token rows
 *   are swept.
 * - `rotate-keys` — after `DataKeyStore.rotateKey`: rewrite rows whose envelope names an
 *   older version (plaintext stragglers are encrypted too), then the caller retires the old
 *   version.
 */
export type EncryptionWalkMode = 'encrypt' | 'retokenize' | 'decrypt' | 'rotate-keys';

export interface EncryptionWalkSummary {
  scanned: number;
  rewritten: number;
  /** Rows whose rewrite lost the race to a concurrent save (re-read and rewritten, or converged by that save). */
  contended: number;
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
 * itself (envelope or not, version current or not; for a JSON column, per leaf against the
 * row's own policy), so a re-run — after a crash, or just to be sure — skips completed rows
 * and continues. Rows written by live traffic mid-walk are already in the new shape and skip
 * too. Run it from a `Migration.run()` for deploy-coupled transitions.
 *
 * THE READ-MODIFY-WRITE RULE (ENCRYPTED_THOUGHT_OBJECT §8 C4): each row's rewrite is one
 * read-write transaction — the read inside it, the write after — so a save that lands between
 * the two aborts the walker's commit (Spanner's serializable transactions), the driver retries
 * the transaction, and the retry re-reads the SAVED body. A non-transactional get→update would
 * overwrite the save with the walker's stale copy and report success — the data-loss class the
 * E1′ pin guards.
 */
export class EncryptionLifecycleWalker {
  private static readonly DEFAULT_WINDOW_SIZE = 200;
  private logger = new Logger({ name: this.constructor.name });
  private encryptedColumns = new EncryptedColumns();
  private envelope = new EncryptionEnvelope();
  private leafCodec = new LeafEnvelopeCodec();
  /**
   * Test seam (typed-cast access only): runs inside the rewrite transaction after the row was
   * read and before it is written — where a concurrent save would land. Never set in product code.
   */
  private interposeBeforeRewrite?: (id: string) => Promise<void>;

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
    let db = (options.db ?? getDbAsSystem()).asContentPreservingRewrite();
    if (mode === 'decrypt') {
      db = db.asDecryptOut();
    }
    const windowSize = options.windowSize ?? EncryptionLifecycleWalker.DEFAULT_WINDOW_SIZE;
    const columnNames = props.map((prop) => ({
      prop,
      columnName: ((table.columns as any)[prop] as { name: string }).name,
    }));
    // Leaf policies resolve from the row's discriminator (a thought's `type`): select what the
    // sources read beside the walked columns so pending-ness is decided under the row's policy.
    const leafProps = new Set(this.encryptedColumns.leafProps(table));
    const dependencyProps = this.encryptedColumns
      .leafPolicyDependencies(table)
      .filter((prop) => !props.includes(prop) && prop !== 'id')
      .map((prop) => ({ prop, columnName: ((table.columns as any)[prop] as { name: string }).name }));
    const activeVersionByOwner = new Map<string, number>();

    const summary: EncryptionWalkSummary = { scanned: 0, rewritten: 0, contended: 0 };
    let cursor = options.startAfterId;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rawRows = await this.rawWindow(table, dbDriver, [...columnNames, ...dependencyProps], cursor, windowSize);
      if (rawRows.length === 0) {
        break;
      }

      for (const rawRow of rawRows) {
        summary.scanned++;
        const pendingProps: string[] = [];
        let policyRow: any | undefined;
        for (const { prop, columnName } of columnNames) {
          let pending: boolean;
          if (leafProps.has(prop)) {
            // The walked columns themselves ride along: a document's own discriminator (a composite's
            // inner type id) is a plaintext key the policy reads.
            policyRow = policyRow ?? (await this.policyRow(table, rawRow, [...columnNames, ...dependencyProps]));
            const policy = await this.encryptedColumns.resolveLeafPolicy(table, prop, policyRow);
            pending = await this.isLeafPending(mode, rawRow[columnName], policy, activeVersionByOwner);
          } else {
            pending = await this.isPending(mode, rawRow[columnName], activeVersionByOwner);
          }
          if (pending) {
            pendingProps.push(prop);
          }
        }

        if (pendingProps.length === 0) {
          continue;
        }

        const outcome = await this.rewriteRow(table, db, rawRow['id'], pendingProps);
        if (outcome === 'rewritten') {
          summary.rewritten++;
        } else if (outcome === 'contended') {
          summary.contended++;
        }
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

    if (typeof rawValue === 'object') {
      // A JSON document on a column that no longer declares `leaves` (the flipped-build
      // rollback path): its stored envelopes still count — decrypt-out and rotation walk them;
      // nothing adopts (no policy says any of it is words).
      const audit = this.leafCodec.audit(rawValue, ALL_STRINGS_CONTENT);
      switch (mode) {
        case 'encrypt':
          return false;
        case 'retokenize':
          return true;
        case 'decrypt':
          return audit.envelopes.length > 0;
        case 'rotate-keys': {
          for (const { owner, version } of audit.envelopes) {
            if (version < (await this.activeVersion(owner, activeVersionByOwner))) {
              return true;
            }
          }
          return false;
        }
      }
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
        return parsed.version < (await this.activeVersion(parsed.owner, activeVersionByOwner));
      }
    }
  }

  /** Per-leaf pending-ness of a stored JSON document against the row's current policy. */
  private async isLeafPending(
    mode: EncryptionWalkMode,
    rawValue: any,
    policy: LeafPolicy,
    activeVersionByOwner: Map<string, number>
  ): Promise<boolean> {
    if (rawValue === null || typeof rawValue === 'undefined') {
      return false;
    }
    if (typeof rawValue === 'string') {
      // A JSON column the driver handed back as text — parse before auditing.
      try {
        rawValue = JSON.parse(rawValue);
      } catch {
        return false;
      }
    }

    const audit = this.leafCodec.audit(rawValue, policy);
    switch (mode) {
      case 'encrypt':
        return audit.plaintextContent.length > 0 || audit.envelopedMetadata.length > 0;
      case 'retokenize':
        return true;
      case 'decrypt':
        return audit.envelopes.length > 0;
      case 'rotate-keys': {
        if (audit.plaintextContent.length > 0) {
          return true;
        }
        for (const { owner, version } of audit.envelopes) {
          if (version < (await this.activeVersion(owner, activeVersionByOwner))) {
            return true;
          }
        }
        return false;
      }
    }
  }

  private async activeVersion(owner: string, activeVersionByOwner: Map<string, number>): Promise<number> {
    let activeVersion = activeVersionByOwner.get(owner);
    if (typeof activeVersion === 'undefined') {
      activeVersion = (await new DataKeyStore().getWriteKey(owner)).version;
      activeVersionByOwner.set(owner, activeVersion);
    }
    return activeVersion;
  }

  /** The property-keyed row a leaf policy source resolves from (the raw dependency columns, deserialized). */
  private async policyRow(
    table: Table<any>,
    rawRow: any,
    dependencyProps: { prop: string; columnName: string }[]
  ): Promise<any> {
    const fieldSerializer = new FieldSerializer(table);
    const row: any = { id: rawRow['id'] };
    for (const { columnName } of dependencyProps) {
      if (typeof rawRow[columnName] === 'undefined') {
        continue;
      }
      const { fieldPropertyName, fieldValue } = await fieldSerializer.deserialize(columnName, rawRow[columnName], rawRow);
      row[fieldPropertyName] = fieldValue;
    }
    return row;
  }

  /**
   * Rewrite one row through the normal seam inside ONE read-write transaction: read it (the
   * deserialize hook decrypts — or passes plaintext through, the adoption path), write the
   * pending columns back (the serialize hook re-derives ciphertext, companions, and tokens
   * under the current config). A save landing between the read and the write aborts the commit;
   * the driver re-runs the transaction against the saved row (see the class doc).
   */
  private async rewriteRow(
    table: Table<any>,
    db: import('../Db').Db<any>,
    id: string,
    pendingProps: string[]
  ): Promise<'rewritten' | 'skipped' | 'contended'> {
    let attempts = 0;
    return await db.runTransaction(async () => {
      attempts++;
      const row = await db.get(table, { id });
      if (!row) {
        return 'skipped'; // deleted mid-walk
      }

      const payload: any = { id };
      for (const prop of pendingProps) {
        if (typeof row[prop] !== 'undefined') {
          payload[prop] = row[prop];
        }
      }

      if (Object.keys(payload).length === 1) {
        return 'skipped';
      }

      if (this.interposeBeforeRewrite) {
        await this.interposeBeforeRewrite(id);
      }
      await db.update(table, payload);
      return attempts > 1 ? 'contended' : 'rewritten';
    });
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
