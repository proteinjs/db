import { createHash } from 'crypto';
import { SerializedRecord } from '../src/Record';
import { Table } from '../src/Table';

/**
 * The declaration stamp — what the sync writes on every row it writes, and what tells a
 * DECLARATION-AUTHORED row from a PRODUCT-AUTHORED one on every later boot:
 *
 * - The stamp names the columns the declaration covered and carries a digest of their values as
 *   the sync wrote them (`{"c":[…column names…],"h":"<sha-256>"}`).
 * - A row whose declared columns still digest to its stamp is the declaration's: the sync may
 *   update it to a changed declaration or remove it when the declaration is gone.
 * - A row whose declared columns no longer match its stamp was edited by the product since the
 *   sync wrote it: it is the product's, and the sync never touches it again — whatever the
 *   declaration says — until the declaration equals it (re-adopted). A declaration that moved as
 *   well, to something else, is a two-sided divergence: the stamp tells both sides apart, since
 *   the declaration's own digest against the stamp says whether the declaration moved.
 * - Columns outside the stamp (runtime-owned fields a declaration never covers) never move a
 *   row's authorship: a product may write them freely under a declaration-authored row.
 *
 * The digest is taken over the SERIALIZED column values (the same normalization the sync's drift
 * comparison uses — dates as ISO strings, objects with their keys sorted), so a row read back
 * from any backing store digests exactly as the declaration that wrote it did. Server-only code
 * (`crypto`) behind the `@proteinjs/db/source` subpath, beside the runner that writes it.
 */
export class SourceRecordStamp {
  /** The stamp for a serialized record over the given column names (physical names). */
  static render(serializedRecord: SerializedRecord, columnNames: string[]): string {
    const columns = Array.from(new Set(columnNames)).sort();
    return JSON.stringify({ c: columns, h: SourceRecordStamp.digest(serializedRecord, columns) });
  }

  /**
   * Whether a stored stamp still matches the serialized row: true when the row's stamped
   * columns digest to the stamp. An unreadable stamp never matches — the conservative side is
   * to treat the row as the product's (never touched) rather than as the sync's (rewritable).
   */
  static matches(stamp: string, serializedRecord: SerializedRecord): boolean {
    const parsed = SourceRecordStamp.parse(stamp);
    if (!parsed) {
      return false;
    }

    return SourceRecordStamp.digest(serializedRecord, parsed.columns) === parsed.hash;
  }

  /** The column names a stored stamp covers, or undefined when the stamp is unreadable. */
  static columnsOf(stamp: string): string[] | undefined {
    return SourceRecordStamp.parse(stamp)?.columns;
  }

  /** The digest a stored stamp carries, or undefined when the stamp is unreadable. */
  static digestOf(stamp: string): string | undefined {
    return SourceRecordStamp.parse(stamp)?.hash;
  }

  /** The digest of a serialized record over a stored stamp's columns (undefined when unreadable). */
  static digestOver(stamp: string, serializedRecord: SerializedRecord): string | undefined {
    const parsed = SourceRecordStamp.parse(stamp);
    return parsed ? SourceRecordStamp.digest(serializedRecord, parsed.columns) : undefined;
  }

  /**
   * The physical column names a declared record covers: every property the record carries that
   * is a column of the table, minus the record's own bookkeeping (`id`, `created`, `updated`)
   * and the sync's stamps (`isLoadedFromSource`, `sourcePackage`, `sourcePackageVersion`,
   * `declarationStamp`).
   */
  static declaredColumnNames(table: Table<any>, record: object): string[] {
    const names: string[] = [];
    for (const property of Object.keys(record)) {
      if (SourceRecordStamp.BOOKKEEPING.has(property)) {
        continue;
      }
      const column = (table.columns as any)[property];
      if (column && typeof (record as any)[property] !== 'function') {
        names.push(column.name);
      }
    }

    return names;
  }

  private static readonly BOOKKEEPING = new Set([
    'id',
    'created',
    'updated',
    'isLoadedFromSource',
    'sourcePackage',
    'sourcePackageVersion',
    'declarationStamp',
  ]);

  private static parse(stamp: string): { columns: string[]; hash: string } | undefined {
    try {
      const parsed = JSON.parse(stamp);
      if (
        !parsed ||
        !Array.isArray(parsed.c) ||
        typeof parsed.h !== 'string' ||
        parsed.c.some((column: unknown) => typeof column !== 'string')
      ) {
        return undefined;
      }

      return { columns: [...parsed.c].sort(), hash: parsed.h };
    } catch {
      return undefined;
    }
  }

  private static digest(serializedRecord: SerializedRecord, columns: string[]): string {
    const hash = createHash('sha256');
    for (const column of columns) {
      hash.update(column);
      hash.update('=');
      hash.update(SourceRecordStamp.canonical(serializedRecord[column]));
      hash.update('\n');
    }

    return hash.digest('hex');
  }

  /**
   * One text per value: null and undefined alike (an absent column is a null one), dates by
   * their ISO form, objects with their keys sorted (backing stores may reorder JSON keys),
   * arrays in their order, everything else as JSON.
   */
  private static canonical(value: unknown): string {
    if (value === null || value === undefined) {
      return 'null';
    }
    if (value instanceof Date) {
      return JSON.stringify(value.toISOString());
    }
    if (Array.isArray(value)) {
      return '[' + value.map((element) => SourceRecordStamp.canonical(element)).join(',') + ']';
    }
    if (typeof value === 'object') {
      const object = value as { [key: string]: unknown };
      const keys = Object.keys(object)
        .filter((key) => object[key] !== undefined)
        .sort();
      return (
        '{' + keys.map((key) => JSON.stringify(key) + ':' + SourceRecordStamp.canonical(object[key])).join(',') + '}'
      );
    }

    return JSON.stringify(value);
  }
}
