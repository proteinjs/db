import { inspect, InspectOptionsStylized } from 'util';
import { SpannerLogValues } from './SpannerLogValues';

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
 * facts an error message carries. Beside the shape and the SQL text, the driver's log lines
 * DESCRIBE the bound parameters (names, types, lengths — SpannerDriver.describeParams); their
 * values ride a line at no level, except behind the dev-only switch (SpannerLogValues).
 */
export type StatementShape = { operation: string; table?: string };

/** The underlying failure, summarized for this error's MESSAGE: the gRPC code, its name, the vendor message (values masked). */
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
 * frame every failure shares. However it is printed, the error never walks its cause: the
 * vendor's words can quote a row's values (see the `util.inspect.custom` hook below).
 */
export class SpannerOperationError extends Error {
  readonly code?: number;
  readonly status?: string;
  /** The vendor error's `details` — for callers; NOT enumerable, so a serialized error carries no raw value. */
  readonly details?: string;
  /** The vendor error's `metadata` — for callers; not enumerable, like `details`. */
  readonly metadata?: unknown;
  /**
   * The vendor error itself — for callers in process; not enumerable, and never printed (the
   * inspect hook names it as withheld): its raw message may quote a row key.
   */
  readonly cause: unknown;

  /** What a printed error shows in the cause's place. */
  private static readonly WITHHELD_CAUSE =
    `<withheld: the backend error can quote row values; its code, status and masked text are above ` +
    `(${SpannerLogValues.DEVELOPMENT_VAR} with ${SpannerLogValues.SWITCH_VAR}=1 puts the bound values of a statement on the driver failure line)>`;

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
   * How this error PRINTS — the one hook every printer goes through: `util.inspect`, so
   * `console.error(error)`, the dev log writer's `{ error }` (the driver's own failure line among
   * them) and any writer that inspects an error. By default those walk an error's `cause`, and the
   * vendor error's words can quote a row's values — a unique index's refusal names the colliding
   * key, on an account table an address. So the printed error is the stack (the name, the message
   * with values masked, the caller's frames) and this error's own facts, with the cause named as
   * withheld and never walked. A structured writer serializes only the enumerable facts, which
   * carry no value either.
   *
   * What the error CARRIES is left exactly as it is: the client library's transaction runner
   * decides its retries off the thrown error (its code, message, details and metadata), and a
   * caller in process still reads `cause`. Only the printed form is this hook's.
   */
  [inspect.custom](depth: number, options: InspectOptionsStylized): string {
    const facts = {
      operation: this.operation,
      statement: this.statement,
      ...(this.code !== undefined ? { code: this.code } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
      ...(this.cause !== undefined ? { cause: SpannerOperationError.WITHHELD_CAUSE } : {}),
    };
    return `${this.stack} ${inspect(facts, { ...options, depth })}`;
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

  /**
   * What failed, in the driver's own words and nothing of the backend's: the operation, the
   * status of `cause` (any thrown value that carries a gRPC `code`) and the statement's verb and
   * table — `Failed when executing dml (ALREADY_EXISTS, code 6) on INSERT ledger`. The opening
   * of this error's message, and the whole of what a log line says of it (SpannerFailureLine).
   */
  static headline(operation: SpannerOperationKind, statement: StatementShape, cause: unknown): string {
    const summary = SpannerOperationError.summarize(cause);
    const status = summary.status ? ` (${summary.status}, code ${summary.code})` : '';
    const target = statement.table ? `${statement.operation} ${statement.table}` : statement.operation;
    return `Failed when executing ${operation}${status} on ${target}`;
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
    const headline = SpannerOperationError.headline(operation, statement, cause);
    return `${headline}: ${SpannerOperationError.summarize(cause).message}`;
  }
}
