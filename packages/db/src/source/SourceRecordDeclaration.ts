import { moment } from '../opt/moment';
import type { Table } from '../Table';
import type { SourceRecord } from './SourceRecord';

/** Whether a column carries moments (a `DateTimeColumn`) — the file format's one typed exception. */
type IsDateTimeColumn = (column: unknown) => boolean;

/** The one format this library reads and writes; bumped only with the document's shape. */
export const SOURCE_RECORD_DECLARATION_FORMAT = 'source-records/1';

/**
 * A DECLARATION of a source-record table's rows as a document — what the export door renders
 * from a database and what the sync loads from a file (see {@link SourceRecordDeclarationFile}).
 *
 * The header names the environment the rows came from (as that environment's consumer configured
 * it), the time of the export that last CHANGED the rows, and the row count. The body is the
 * table's sync key (and the column that scopes it, when the table scopes its key), the columns the
 * declaration covers (`sourceRecordOptions.declarationColumns`, the key and its scope always among
 * them — never a column the table did not declare exportable, never `id` unless it is the key,
 * never `created`/`updated`), the columns whose value lives in a sibling file
 * (`sourceRecordOptions.externalColumns`), and every row over exactly those columns.
 *
 * Values are JSON-native — strings, numbers, booleans, null, arrays and objects of those — with
 * TWO typed exceptions: a `DateTimeColumn` value is an ISO-8601 UTC string, parsed back to a
 * moment on load; an EXTERNAL column's value is the path of its sibling file relative to the
 * document (`<key>/<column>.md`, the scope value before the key when scoped) or null, the text
 * itself carried beside the document (see {@link SourceRecordDeclarationBundle}). Any other value
 * the format cannot carry is refused by the export by name.
 *
 * Rendered BYTE-STABLY (`render`): keys sorted at every level, rows sorted by the key (the scope
 * first), two-space indentation, a trailing newline — so two exports of the same rows are the
 * same bytes and a re-pull with no change is a no-op diff (the pull command compares rows and
 * sibling files and leaves them, header time included, untouched when nothing moved).
 */
export type SourceRecordDeclaration = {
  format: typeof SOURCE_RECORD_DECLARATION_FORMAT;
  /** The table's name. */
  table: string;
  /** The sync key (a property name): `id`, or the table's natural key. */
  key: string;
  /** The column (a property name) that scopes the key, when the table scopes its natural key. */
  scope?: string;
  /** The columns (property names) every row carries — sorted. */
  columns: string[];
  /** The columns whose row value is a sibling file's path — sorted; absent when none. */
  externalColumns?: string[];
  /** The source environment, as its consumer configured it. */
  environment: string;
  /** ISO-8601 time of the export that last changed the rows. */
  exportedAt: string;
  rowCount: number;
  /** Every row, over exactly `columns`, sorted by `scope` then `key`. */
  rows: { [column: string]: unknown }[];
};

/**
 * A declaration with its sibling files: the texts of every external column, keyed by the path
 * the row carries (relative to the document). What the export door returns and the pull command
 * writes; what the sync reads back.
 */
export type SourceRecordDeclarationBundle = {
  declaration: SourceRecordDeclaration;
  files: { [relativePath: string]: string };
};

/** The shape a table declares for its declarations, validated (see {@link SourceRecordDeclarationDocument.shapeOf}). */
export type SourceRecordDeclarationShape = {
  key: string;
  scope?: string;
  /** Every property a declaration may cover: the declared columns plus the key and its scope. */
  columns: Set<string>;
  /** Sorted. */
  externalColumns: string[];
  filter: { [column: string]: unknown };
};

export class SourceRecordDeclarationDocument {
  /** The byte-stable text of a declaration (see the type's doc for the rules). */
  static render(declaration: SourceRecordDeclaration): string {
    const normalized: SourceRecordDeclaration = {
      ...declaration,
      columns: [...declaration.columns].sort(),
      externalColumns:
        declaration.externalColumns && declaration.externalColumns.length > 0
          ? [...declaration.externalColumns].sort()
          : undefined,
      rowCount: declaration.rows.length,
      rows: SourceRecordDeclarationDocument.sortRows(declaration.rows, declaration.key, declaration.scope),
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
    if (parsed.scope !== undefined && (typeof parsed.scope !== 'string' || parsed.scope.length === 0)) {
      throw new Error(`${origin} has a 'scope' that is not a column name`);
    }
    if (!Array.isArray(parsed.columns) || parsed.columns.some((column: unknown) => typeof column !== 'string')) {
      throw new Error(`${origin} is missing 'columns' (the property names every row carries)`);
    }
    if (
      parsed.externalColumns !== undefined &&
      (!Array.isArray(parsed.externalColumns) ||
        parsed.externalColumns.some((column: unknown) => typeof column !== 'string'))
    ) {
      throw new Error(`${origin} has 'externalColumns' that are not column names`);
    }
    if (!Array.isArray(parsed.rows)) {
      throw new Error(`${origin} is missing 'rows'`);
    }
    const columns = new Set<string>(parsed.columns);
    if (!columns.has(parsed.key)) {
      throw new Error(`${origin}: the key '${parsed.key}' is not among its columns`);
    }
    if (parsed.scope !== undefined && !columns.has(parsed.scope)) {
      throw new Error(`${origin}: the scope '${parsed.scope}' is not among its columns`);
    }
    const externalColumns: string[] = [...(parsed.externalColumns ?? [])].sort();
    for (const column of externalColumns) {
      if (!columns.has(column)) {
        throw new Error(`${origin}: the external column '${column}' is not among its columns`);
      }
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
      for (const field of parsed.scope === undefined ? [parsed.key] : [parsed.scope, parsed.key]) {
        const value = (row as any)[field];
        if (value === undefined || value === null || value === '') {
          throw new Error(`${origin}: row ${index} has no '${field}'`);
        }
      }
      for (const column of externalColumns) {
        const value = (row as any)[column];
        if (value !== null && value !== undefined && typeof value !== 'string') {
          throw new Error(
            `${origin}: row ${index} carries '${column}', which is external, as something other than a path`
          );
        }
      }
    });
    if (typeof parsed.rowCount === 'number' && parsed.rowCount !== parsed.rows.length) {
      throw new Error(`${origin}: rowCount ${parsed.rowCount} but ${parsed.rows.length} rows`);
    }

    return {
      format: SOURCE_RECORD_DECLARATION_FORMAT,
      table: parsed.table,
      key: parsed.key,
      ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
      columns: [...parsed.columns].sort(),
      ...(externalColumns.length === 0 ? {} : { externalColumns }),
      environment: parsed.environment,
      exportedAt: parsed.exportedAt,
      rowCount: parsed.rows.length,
      rows: parsed.rows,
    };
  }

  /**
   * A declaration's rows as records of the table — the file's values become the table's
   * (ISO strings become moments on date-time columns; an external column's sibling file, read
   * through `readFile` by the path the row carries, becomes its text). Refuses a document for
   * another table, a key or scope other than the table's, a column outside the table's declared
   * `declarationColumns` (a table declaring none accepts no declaration file), external columns
   * other than the table's, and a row outside the table's `declarationFilter`.
   */
  static async toRecords<T extends SourceRecord>(
    table: Table<T>,
    declaration: SourceRecordDeclaration,
    readFile?: (relativePath: string) => string
  ): Promise<Omit<T, 'created' | 'updated'>[]> {
    if (declaration.table !== table.name) {
      throw new Error(`(${table.name}) The declaration is for table '${declaration.table}'`);
    }
    const shape = SourceRecordDeclarationDocument.shapeOf(table);
    if (declaration.key !== shape.key) {
      throw new Error(
        `(${table.name}) The declaration keys on '${declaration.key}'; the table syncs on '${shape.key}'`
      );
    }
    if ((declaration.scope ?? undefined) !== shape.scope) {
      throw new Error(
        `(${table.name}) The declaration ${declaration.scope ? `scopes its key by '${declaration.scope}'` : 'scopes nothing'}; ` +
          `the table ${shape.scope ? `scopes its key by '${shape.scope}'` : 'scopes nothing'}`
      );
    }
    for (const column of declaration.columns) {
      if (!shape.columns.has(column)) {
        throw new Error(
          `(${table.name}) The declaration carries '${column}', which is not a declaration column of the table ` +
            `(sourceRecordOptions.declarationColumns)`
        );
      }
    }
    const external = [...(declaration.externalColumns ?? [])].sort();
    if (external.join(',') !== shape.externalColumns.join(',')) {
      throw new Error(
        `(${table.name}) The declaration's external columns [${external.join(', ')}] are not the table's ` +
          `[${shape.externalColumns.join(', ')}] (sourceRecordOptions.externalColumns)`
      );
    }
    if (external.length > 0 && !readFile) {
      throw new Error(
        `(${table.name}) The declaration carries external columns and no reader for their files was given`
      );
    }

    const isDateTime = await SourceRecordDeclarationDocument.dateTimeColumnTest();
    const externalSet = new Set(external);
    return declaration.rows.map((row, index) => {
      SourceRecordDeclarationDocument.assertWithinFilter(table, shape.filter, row, `row ${index}`);
      const record: any = {};
      for (const column of declaration.columns) {
        if (externalSet.has(column)) {
          const path = row[column];
          record[column] =
            path === null || path === undefined ? null : (readFile as (p: string) => string)(path as string);
          continue;
        }
        record[column] = SourceRecordDeclarationDocument.fromFileValue(table, column, row[column], isDateTime);
      }
      return record;
    });
  }

  /**
   * A declaration from records of the table over the table's declaration columns: the table's
   * values become the file's (moments become ISO strings; an external column's text becomes a
   * sibling file, its path on the row). Refuses a value the format cannot carry, by table and
   * column, and a record outside the table's `declarationFilter`.
   */
  static async fromRecords<T extends SourceRecord>(
    table: Table<T>,
    records: Partial<T>[],
    header: { environment: string; exportedAt: string }
  ): Promise<SourceRecordDeclarationBundle> {
    const shape = SourceRecordDeclarationDocument.shapeOf(table);
    const columns = Array.from(shape.columns).sort();
    const isDateTime = await SourceRecordDeclarationDocument.dateTimeColumnTest();
    const externalSet = new Set(shape.externalColumns);
    const files: { [relativePath: string]: string } = {};
    const rows = records.map((record, index) => {
      SourceRecordDeclarationDocument.assertWithinFilter(table, shape.filter, record as any, `record ${index}`);
      const row: { [column: string]: unknown } = {};
      for (const column of columns) {
        const value = (record as any)[column];
        if (externalSet.has(column)) {
          if (value === null || value === undefined) {
            row[column] = null;
            continue;
          }
          if (typeof value !== 'string') {
            throw new Error(`(${table.name}) '${column}' is external and holds a value that is not text`);
          }
          const path = SourceRecordDeclarationDocument.externalPath(record as any, column, shape);
          files[path] = value;
          row[column] = path;
          continue;
        }
        row[column] = SourceRecordDeclarationDocument.toFileValue(table, column, value, isDateTime);
      }
      return row;
    });

    return {
      declaration: {
        format: SOURCE_RECORD_DECLARATION_FORMAT,
        table: table.name,
        key: shape.key,
        ...(shape.scope === undefined ? {} : { scope: shape.scope }),
        columns,
        ...(shape.externalColumns.length === 0 ? {} : { externalColumns: shape.externalColumns }),
        environment: header.environment,
        exportedAt: header.exportedAt,
        rowCount: rows.length,
        rows: SourceRecordDeclarationDocument.sortRows(rows, shape.key, shape.scope),
      },
      files,
    };
  }

  /** Whether two declarations carry the same rows (the header's time aside). */
  static sameRows(a: SourceRecordDeclaration, b: SourceRecordDeclaration): boolean {
    const body = (declaration: SourceRecordDeclaration) =>
      SourceRecordDeclarationDocument.render({ ...declaration, exportedAt: '' });
    return body(a) === body(b);
  }

  /** Whether two bundles carry the same rows and the same sibling files, byte for byte (the header's time aside). */
  static sameBundle(a: SourceRecordDeclarationBundle, b: SourceRecordDeclarationBundle): boolean {
    if (!SourceRecordDeclarationDocument.sameRows(a.declaration, b.declaration)) {
      return false;
    }
    const paths = Object.keys(a.files).sort();
    if (paths.join('\n') !== Object.keys(b.files).sort().join('\n')) {
      return false;
    }
    return paths.every((path) => a.files[path] === b.files[path]);
  }

  /**
   * The property names a declaration of the table may cover: `declarationColumns` plus the sync
   * key and its scope. Empty when the table declares none.
   */
  static declarationColumns(table: Table<any>): Set<string> {
    const declared = table.sourceRecordOptions.declarationColumns;
    if (!declared || declared.length === 0) {
      return new Set();
    }

    return SourceRecordDeclarationDocument.shapeOf(table).columns;
  }

  /**
   * The shape the table declares for its declarations — the key, its scope, the columns, the
   * external columns and the row filter — each validated against the table's columns: a name
   * that is not a column property, an external or filter column outside the declaration
   * columns, an external column that is not a text column, or a scope without a natural key,
   * fails by name. A table declaring no declaration columns has an empty shape (no column at
   * all): it is not exportable and accepts no declaration file.
   */
  static shapeOf(table: Table<any>): SourceRecordDeclarationShape {
    const options = table.sourceRecordOptions;
    const key = options.naturalKey ?? 'id';
    const scope = options.naturalKeyScope;
    if (scope !== undefined && !options.naturalKey) {
      throw new Error(`(${table.name}) sourceRecordOptions.naturalKeyScope '${scope}' needs a naturalKey to scope`);
    }
    const declared = options.declarationColumns ?? [];
    const named = (name: string, option: string) => {
      if (!(table.columns as any)[name]) {
        throw new Error(`(${table.name}) sourceRecordOptions.${option} names '${name}', not a column property`);
      }
    };
    for (const column of declared) {
      named(column, 'declarationColumns');
    }
    if (declared.length === 0) {
      return { key, scope, columns: new Set(), externalColumns: [], filter: {} };
    }
    const columns = new Set<string>([...declared, key, ...(scope === undefined ? [] : [scope])]);
    const externalColumns = [...(options.externalColumns ?? [])].sort();
    for (const column of externalColumns) {
      named(column, 'externalColumns');
      if (!columns.has(column)) {
        throw new Error(
          `(${table.name}) sourceRecordOptions.externalColumns names '${column}', which is not a declaration column`
        );
      }
      if (column === key || column === scope) {
        throw new Error(`(${table.name}) sourceRecordOptions.externalColumns names the key '${column}'`);
      }
    }
    const filter: { [column: string]: unknown } = {};
    for (const column of Object.keys(options.declarationFilter ?? {})) {
      named(column, 'declarationFilter');
      if (!columns.has(column)) {
        throw new Error(
          `(${table.name}) sourceRecordOptions.declarationFilter names '${column}', which is not a declaration column`
        );
      }
      filter[column] = (options.declarationFilter as any)[column];
    }

    return { key, scope, columns, externalColumns, filter };
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

  /** The sibling file's path for an external column of a record: `<scope>/<key>/<column>.md`, each value url-encoded. */
  private static externalPath(
    record: { [column: string]: unknown },
    column: string,
    shape: SourceRecordDeclarationShape
  ) {
    const parts = shape.scope === undefined ? [record[shape.key]] : [record[shape.scope], record[shape.key]];
    return [...parts.map((part) => encodeURIComponent(String(part))), `${column}.md`].join('/');
  }

  /** A row (file values) or record (table values) is refused by name when it is outside the table's filter. */
  private static assertWithinFilter(
    table: Table<any>,
    filter: { [column: string]: unknown },
    row: { [column: string]: unknown },
    what: string
  ): void {
    for (const column of Object.keys(filter)) {
      if (JSON.stringify(row[column] ?? null) !== JSON.stringify(filter[column] ?? null)) {
        throw new Error(
          `(${table.name}) The declaration's ${what} is outside the table's declarationFilter: ` +
            `'${column}' is ${JSON.stringify(row[column] ?? null)}, the filter says ${JSON.stringify(filter[column] ?? null)}`
        );
      }
    }
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

  private static sortRows(
    rows: { [column: string]: unknown }[],
    key: string,
    scope?: string
  ): { [column: string]: unknown }[] {
    // Always a (scope text, key text) pair — an unscoped key sorts within one empty scope — so two
    // rows sharing a key (a duplicate the sync refuses by name) compare without a crash.
    const order = (row: { [column: string]: unknown }): [string, string] =>
      scope === undefined ? ['', String(row[key])] : [String(row[scope]), String(row[key])];
    return [...rows].sort((a, b) => {
      const [sa, ka] = order(a);
      const [sb, kb] = order(b);
      return sa === sb ? ka.localeCompare(kb) : sa.localeCompare(sb);
    });
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
