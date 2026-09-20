/** gRPC status names by code — what a vendor error's `code` means, spelled for humans and logs. */
export const GRPC_STATUS_NAMES: { [code: number]: string } = {
  0: 'OK',
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
};

export type SpannerOperationKind = 'query' | 'dml';

/**
 * The SHAPE of a statement — its verb and the table it acts on, never a value — the statement
 * facts an error message carries. No log line at any level carries a row value: beside the shape
 * and the SQL text, the driver's lines DESCRIBE the bound parameters (names, types, lengths —
 * SpannerDriver.describeParams).
 */
export type StatementShape = { operation: string; table?: string };

/** The underlying failure, summarized for a log line: the gRPC code, its name, the vendor message (values masked). */
export type OperationCauseSummary = { code?: number; status?: string; message: string };

/** Free text that reaches a log line or an error message is one line and bounded. */
const MAX_MESSAGE_CHARS = 300;

/**
 * A failed Spanner data operation — what `SpannerDriver.runQuery` / `runDml` throw when the
 * vendor client rejects. The vendor error rides as `cause` (its `code`, `details` and `metadata`
 * are ALSO copied onto this error, so callers branching on the gRPC status — an ALREADY_EXISTS
 * adopt-the-winner path checking `error.code === 6` — keep working unchanged); the message names
 * the status and the statement's shape; the stack is the CALLER's (captured where the driver was
 * entered, before the vendor client's own frames take over), so an error report through this
 * driver locates the application code that issued the statement instead of a client-library
 * frame every failure shares.
 */
export class SpannerOperationError extends Error {
  readonly code?: number;
  readonly status?: string;
  /** The vendor error's `details` — for callers; NOT enumerable, so a serialized error carries no raw value. */
  readonly details?: string;
  /** The vendor error's `metadata` — for callers; not enumerable, like `details`. */
  readonly metadata?: unknown;
  /** The vendor error itself — for callers; not enumerable: its raw message may quote a row key. */
  readonly cause: unknown;

  constructor(
    readonly operation: SpannerOperationKind,
    readonly statement: StatementShape,
    cause: unknown,
    callSiteStack?: string
  ) {
    super(SpannerOperationError.describe(operation, statement, cause));
    this.name = 'SpannerOperationError';
    Object.setPrototypeOf(this, SpannerOperationError.prototype);
    const vendor = cause as { code?: unknown; details?: unknown; metadata?: unknown } | null | undefined;
    if (typeof vendor?.code === 'number') {
      this.code = vendor.code;
      this.status = GRPC_STATUS_NAMES[vendor.code];
    }
    // Raw vendor fields ride for callers only: a structured log writer that serializes the error's
    // enumerable properties must never see a row key through them (the values law).
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false, writable: false });
    if (typeof vendor?.details === 'string') {
      Object.defineProperty(this, 'details', { value: vendor.details, enumerable: false, writable: false });
    }
    if (vendor?.metadata !== undefined) {
      Object.defineProperty(this, 'metadata', { value: vendor.metadata, enumerable: false, writable: false });
    }
    if (callSiteStack) {
      this.stack = `${this.name}: ${this.message}\n${callSiteStack}`;
    }
  }

  /** The underlying failure as a log line carries it. */
  causeSummary(): OperationCauseSummary {
    return SpannerOperationError.summarize(this.cause);
  }

  /**
   * What `util.inspect` prints for this error — so what `console.*` and any log writer built on it
   * (the default dev writer) print. The stock rendering appends `[cause]` even though the property
   * is not enumerable, and the vendor error's raw message quotes the offending row key; this
   * rendering is the stack and the enumerable facts, nothing else. Callers still read `cause`.
   */
  [Symbol.for('nodejs.util.inspect.custom')](
    _depth: number,
    options: object,
    inspect?: (value: unknown, options?: object) => string
  ): string {
    const facts = { ...this };
    const header = this.stack ?? `${this.name}: ${this.message}`;
    return `${header} ${inspect ? inspect(facts, options) : JSON.stringify(facts)}`;
  }

  /**
   * `{ code, status, message }` of any thrown value — the vendor error, a typed driver error, a
   * string — with the message's VALUES masked: the backend quotes the offending row key or index
   * key in its text (`primary key ({pk#id:"…"})`, `index key [...]`), and a unique index over a
   * personal column would print that value into every error log line.
   */
  static summarize(cause: unknown): OperationCauseSummary {
    const vendor = cause as { code?: unknown; message?: unknown } | null | undefined;
    const code = typeof vendor?.code === 'number' ? vendor.code : undefined;
    const raw = typeof vendor?.message === 'string' ? vendor.message : String(cause);
    return {
      ...(code !== undefined ? { code, status: GRPC_STATUS_NAMES[code] ?? `code ${code}` } : {}),
      message: SpannerOperationError.maskValues(raw),
    };
  }

  /** Quoted strings, bracketed/braced keys and long numbers → placeholders; one bounded line. */
  static maskValues(text: string): string {
    return String(text ?? '')
      .replace(/"(?:[^"\\]|\\.)*"/g, '"…"')
      .replace(/'(?:[^'\\]|\\.)*'/g, "'…'")
      .replace(/\{[^{}\n]{1,300}\}/g, '{…}')
      .replace(/\[[^\]\n]{1,300}\]/g, '[…]')
      .replace(/\b\d{4,}\b/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_MESSAGE_CHARS);
  }

  /**
   * The verb and table of a statement (`INSERT INTO \`flow_case\` (...)` → INSERT · flow_case;
   * `SELECT ... FROM \`chat\` ...` → SELECT · chat). Never a value: the parse stops at the table
   * name. An unrecognized statement keeps its first word as the operation and no table.
   */
  static statementShape(sql: string): StatementShape {
    const text = String(sql ?? '').trim();
    const dml = /^(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO)\s+`?([\w.]+)`?/i.exec(text);
    if (dml) {
      const verb = dml[1].toUpperCase();
      const operation = verb.startsWith('INSERT')
        ? 'INSERT'
        : verb.startsWith('DELETE')
          ? 'DELETE'
          : verb.split(/\s+/)[0];
      return { operation, table: dml[2] };
    }
    if (/^(SELECT|WITH)\b/i.test(text)) {
      const from = /\bFROM\s+`?([\w.]+)`?/i.exec(text);
      return { operation: 'SELECT', ...(from ? { table: from[1] } : {}) };
    }
    const firstWord = text.split(/\s+/)[0];
    return { operation: firstWord ? firstWord.toUpperCase() : 'UNKNOWN' };
  }

  private static describe(operation: SpannerOperationKind, statement: StatementShape, cause: unknown): string {
    const summary = SpannerOperationError.summarize(cause);
    const status = summary.status ? ` (${summary.status}, code ${summary.code})` : '';
    const target = statement.table ? `${statement.operation} ${statement.table}` : statement.operation;
    return `Failed when executing ${operation}${status} on ${target}: ${summary.message}`;
  }
}
