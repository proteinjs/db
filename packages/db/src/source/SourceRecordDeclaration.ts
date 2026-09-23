import { moment } from '../opt/moment';
import type { Table } from '../Table';
import type { SourceRecord } from './SourceRecord';

/** Whether a column carries moments (a `DateTimeColumn`) — the file format's one typed exception. */
type IsDateTimeColumn = (column: unknown) => boolean;

/** The one format this library reads and writes; bumped only with the document's shape. */
export const SOURCE_RECORD_DECLARATION_FORMAT = 'source-records/1';

/**
 * A DECLARATION of a source-record table's rows as a document — what the export door renders
 * from a database and what the loader loads from a file (see {@link SourceRecordDeclarationFile}).
 *
 * The header names the environment the rows came from (as that environment's consumer configured
 * it), the time of the export that last CHANGED the rows, and the row count. The body is the
 * table's sync key, the columns the declaration covers (`sourceRecordOptions.declarationColumns`,
 * the key always among them — never a column the table did not declare exportable, never `id`
 * unless it is the key, never `created`/`updated`), and every row over exactly those columns.
 *
 * Values are JSON-native — strings, numbers, booleans, null, arrays and objects of those — with
 * ONE typed exception: a `DateTimeColumn` value is an ISO-8601 UTC string, parsed back to a
 * moment on load. Any other value the format cannot carry is refused by the export by name.
 *
 * Rendered BYTE-STABLY (`render`): keys sorted at every level, rows sorted by the key, two-space
 * indentation, a trailing newline — so two exports of the same rows are the same bytes and a
 * re-pull with no change is a no-op diff (the pull command compares rows and leaves the file,
 * header time included, untouched when nothing moved).
 */
export type SourceRecordDeclaration = {
  format: typeof SOURCE_RECORD_DECLARATION_FORMAT;
  /** The table's name. */
  table: string;
  /** The sync key (a property name): `id`, or the table's natural key. */
  key: string;
  /** The columns (property names) every row carries — sorted. */
  columns: string[];
  /** The source environment, as its consumer configured it. */
  environment: string;
  /** ISO-8601 time of the export that last changed the rows. */
  exportedAt: string;
  rowCount: number;
  /** Every row, over exactly `columns`, sorted by `key`. */
  rows: { [column: string]: unknown }[];
};

export class SourceRecordDeclarationDocument {
  /** The byte-stable text of a declaration (see the type's doc for the rules). */
  static render(declaration: SourceRecordDeclaration): string {
    const normalized: SourceRecordDeclaration = {
      ...declaration,
      columns: [...declaration.columns].sort(),
      rowCount: declaration.rows.length,
      rows: SourceRecordDeclarationDocument.sortRows(declaration.rows, declaration.key),
    };
    return JSON.stringify(SourceRecordDeclarationDocument.sortKeys(normalized), null, 2) + '\n';
  }

  /** Parse and validate a declaration's text; `origin` names the file in every refusal. */
  static parse(text: string, origin = 'the declaration'): SourceRecordDeclaration {
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`${origin} is not JSON: ${(error as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${origin} is not a declaration document`);
    }
    if (parsed.format !== SOURCE_RECORD_DECLARATION_FORMAT) {
      throw new Error(
        `${origin} has format '${parsed.format}' — this library reads '${SOURCE_RECORD_DECLARATION_FORMAT}'`
      );
    }
    for (const field of ['table', 'key', 'environment', 'exportedAt'] as const) {
      if (typeof parsed[field] !== 'string' || parsed[field].length === 0) {
        throw new Error(`${origin} is missing '${field}'`);
      }
    }
    if (!Array.isArray(parsed.columns) || parsed.columns.some((column: unknown) => typeof column !== 'string')) {
      throw new Error(`${origin} is missing 'columns' (the property names every row carries)`);
    }
    if (!Array.isArray(parsed.rows)) {
      throw new Error(`${origin} is missing 'rows'`);
    }
    const columns = new Set<string>(parsed.columns);
    if (!columns.has(parsed.key)) {
      throw new Error(`${origin}: the key '${parsed.key}' is not among its columns`);
    }
    parsed.rows.forEach((row: unknown, index: number) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`${origin}: row ${index} is not an object`);
      }
      for (const property of Object.keys(row as object)) {
        if (!columns.has(property)) {
          throw new Error(`${origin}: row ${index} carries '${property}', which is not among its columns`);
        }
      }
      const key = (row as any)[parsed.key];
      if (key === undefined || key === null || key === '') {
        throw new Error(`${origin}: row ${index} has no '${parsed.key}'`);
      }
    });
    if (typeof parsed.rowCount === 'number' && parsed.rowCount !== parsed.rows.length) {
      throw new Error(`${origin}: rowCount ${parsed.rowCount} but ${parsed.rows.length} rows`);
    }

    return {
      format: SOURCE_RECORD_DECLARATION_FORMAT,
      table: parsed.table,
      key: parsed.key,
      columns: [...parsed.columns].sort(),
      environment: parsed.environment,
      exportedAt: parsed.exportedAt,
      rowCount: parsed.rows.length,
      rows: parsed.rows,
    };
  }

  /**
   * A declaration's rows as records of the table — the file's values become the table's
   * (ISO strings become moments on date-time columns). Refuses a document for another table,
   * a key other than the table's sync key, or a column outside the table's declared
   * `declarationColumns` (a table declaring none accepts no declaration file).
   */
  static async toRecords<T extends SourceRecord>(
    table: Table<T>,
    declaration: SourceRecordDeclaration
  ): Promise<Omit<T, 'created' | 'updated'>[]> {
    if (declaration.table !== table.name) {
      throw new Error(`(${table.name}) The declaration is for table '${declaration.table}'`);
    }
    const key = table.sourceRecordOptions.naturalKey ?? 'id';
    if (declaration.key !== key) {
      throw new Error(`(${table.name}) The declaration keys on '${declaration.key}'; the table syncs on '${key}'`);
    }
    const allowed = SourceRecordDeclarationDocument.declarationColumns(table);
    for (const column of declaration.columns) {
      if (!allowed.has(column)) {
        throw new Error(
          `(${table.name}) The declaration carries '${column}', which is not a declaration column of the table ` +
            `(sourceRecordOptions.declarationColumns)`
        );
      }
    }

    const isDateTime = await SourceRecordDeclarationDocument.dateTimeColumnTest();
    return declaration.rows.map((row) => {
      const record: any = {};
      for (const column of declaration.columns) {
        record[column] = SourceRecordDeclarationDocument.fromFileValue(table, column, row[column], isDateTime);
      }
      return record;
    });
  }

  /**
   * A declaration from records of the table over the table's declaration columns: the table's
   * values become the file's (moments become ISO strings). Refuses a value the format cannot
   * carry, by table and column.
   */
  static async fromRecords<T extends SourceRecord>(
    table: Table<T>,
    records: Partial<T>[],
    header: { environment: string; exportedAt: string }
  ): Promise<SourceRecordDeclaration> {
    const key = table.sourceRecordOptions.naturalKey ?? 'id';
    const columns = Array.from(SourceRecordDeclarationDocument.declarationColumns(table)).sort();
    const isDateTime = await SourceRecordDeclarationDocument.dateTimeColumnTest();
    const rows = records.map((record) => {
      const row: { [column: string]: unknown } = {};
      for (const column of columns) {
        row[column] = SourceRecordDeclarationDocument.toFileValue(table, column, (record as any)[column], isDateTime);
      }
      return row;
    });

    return {
      format: SOURCE_RECORD_DECLARATION_FORMAT,
      table: table.name,
      key,
      columns,
      environment: header.environment,
      exportedAt: header.exportedAt,
      rowCount: rows.length,
      rows: SourceRecordDeclarationDocument.sortRows(rows, key),
    };
  }

  /** Whether two declarations carry the same rows (the header's time aside). */
  static sameRows(a: SourceRecordDeclaration, b: SourceRecordDeclaration): boolean {
    const body = (declaration: SourceRecordDeclaration) =>
      SourceRecordDeclarationDocument.render({ ...declaration, exportedAt: '' });
    return body(a) === body(b);
  }

  /**
   * The property names a declaration of the table may cover: `declarationColumns` plus the sync
   * key. Empty when the table declares none.
   */
  static declarationColumns(table: Table<any>): Set<string> {
    const declared = table.sourceRecordOptions.declarationColumns;
    if (!declared || declared.length === 0) {
      return new Set();
    }
    for (const column of declared) {
      if (!(table.columns as any)[column]) {
        throw new Error(
          `(${table.name}) sourceRecordOptions.declarationColumns names '${column}', not a column property`
        );
      }
    }

    return new Set([...declared, table.sourceRecordOptions.naturalKey ?? 'id']);
  }

  /**
   * The date-time column test, imported at call time: this module sits beside the column
   * classes in the package's module graph (Columns → ReferenceArray → Db → Table → Record →
   * Columns), and a top-level import from an entry that starts here would evaluate Record's
   * columns while Columns.ts is still mid-load.
   */
  private static async dateTimeColumnTest(): Promise<IsDateTimeColumn> {
    const { DateTimeColumn } = await import('../Columns');
    return (column: unknown) => column instanceof DateTimeColumn;
  }

  private static toFileValue(table: Table<any>, column: string, value: unknown, isDateTime: IsDateTimeColumn): unknown {
    if (value === undefined || value === null) {
      return null;
    }
    if (isDateTime((table.columns as any)[column])) {
      if (!moment.isMoment(value) && !(value instanceof Date)) {
        throw new Error(`(${table.name}) '${column}' holds a value the declaration format cannot carry as a date`);
      }
      return moment.utc(value as Date).toISOString();
    }
    SourceRecordDeclarationDocument.assertJsonNative(table, column, value);
    return value;
  }

  private static fromFileValue(
    table: Table<any>,
    column: string,
    value: unknown,
    isDateTime: IsDateTimeColumn
  ): unknown {
    if (value === undefined || value === null) {
      return null;
    }
    if (isDateTime((table.columns as any)[column])) {
      if (typeof value !== 'string' || !moment.utc(value, moment.ISO_8601, true).isValid()) {
        throw new Error(`(${table.name}) '${column}' must be an ISO-8601 date-time string in a declaration`);
      }
      return moment.utc(value);
    }

    return value;
  }

  private static assertJsonNative(table: Table<any>, column: string, value: unknown): void {
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((element) => SourceRecordDeclarationDocument.assertJsonNative(table, column, element));
      return;
    }
    if (kind === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
      for (const nested of Object.values(value as object)) {
        SourceRecordDeclarationDocument.assertJsonNative(table, column, nested);
      }
      return;
    }
    throw new Error(
      `(${table.name}) '${column}' holds a value the declaration format cannot carry (${kind}) — leave it out of ` +
        `declarationColumns or store it as plain JSON`
    );
  }

  private static sortRows(rows: { [column: string]: unknown }[], key: string): { [column: string]: unknown }[] {
    return [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  }

  private static sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((element) => SourceRecordDeclarationDocument.sortKeys(element));
    }
    if (value && typeof value === 'object') {
      const object = value as { [key: string]: unknown };
      const sorted: { [key: string]: unknown } = {};
      for (const key of Object.keys(object).sort()) {
        if (object[key] !== undefined) {
          sorted[key] = SourceRecordDeclarationDocument.sortKeys(object[key]);
        }
      }
      return sorted;
    }
    return value;
  }
}
