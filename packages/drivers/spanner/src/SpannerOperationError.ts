import { SpannerDriverError } from './SpannerDriverError';
import { OperationCauseSummary, SpannerFailureText } from './SpannerFailureText';

export type SpannerOperationKind = 'query' | 'dml' | 'commit' | 'schema update';

/**
 * The SHAPE of a statement — its verb and the table it acts on, never a value — the statement
 * facts an error message carries. No log line at any level carries a row value: beside the shape
 * and the SQL text, the driver's lines DESCRIBE the bound parameters (names, types, lengths —
 * SpannerDriver.describeParams) and name the failure in the driver's own words
 * (SpannerFailureText).
 */
export type StatementShape = { operation: string; table?: string };

/** The key of the one metadata entry the typed error passes on: the backend's retry delay. */
const RETRY_INFO_KEY = 'google.rpc.retryinfo-bin';

/** The vendor client's gRPC metadata, as far as this file reads it. */
type VendorMetadata = {
  clone(): VendorMetadata;
  getMap(): { [key: string]: unknown };
  remove(key: string): void;
};

/**
 * A failed Spanner operation — what `SpannerDriver.runQuery` / `runDml` / `runUpdateSchema` throw
 * when the vendor client rejects, and what a failed commit throws inside `runTransaction`.
 *
 * Its message, its stack and every property a printer can reach are value-free: the message names
 * the gRPC status, the statement's shape and the driver's sentence for the failure's class
 * (`failureClass` — SpannerFailureText owns both); the backend's own message is NOT in it, because
 * that text echoes whatever value it choked on. The gRPC `code` is copied, so callers branching on
 * the status — an ALREADY_EXISTS adopt-the-winner path checking `error.code === 6` — keep working
 * unchanged. The stack is the CALLER's (captured where the driver was entered, before the vendor
 * client's own frames take over), so an error report through this driver locates the application
 * code that issued the statement instead of a client-library frame every failure shares.
 *
 * The vendor error itself is `vendorError()` — for a caller that asks for it by name, and for
 * nothing else; never the standard `cause`, never a property of the instance, never an accessor
 * (SpannerDriverError owns that). Read the backend's raw `message` and `details` there, knowing
 * they can carry row values. `metadata` passes on the ONE entry the client library's transaction runner reads off a
 * thrown error — the backend's retry delay — and nothing else of the vendor's trailers (their
 * status-details entry repeats the raw message).
 */
export class SpannerOperationError extends SpannerDriverError {
  /** Each error's summary — held beside the instance, never on it. */
  private static readonly SUMMARIES = new WeakMap<SpannerOperationError, OperationCauseSummary>();
  readonly code?: number;
  readonly status?: string;
  /** The class SpannerFailureText recognized the failure as (`unclassified` when it is none of them). */
  readonly failureClass: string;

  /**
   * @param boundValues the failed statement's parameter values — struck out of anything the
   * failure's sentence keeps (SpannerFailureText); never stored.
   *
   * The `operation` is also the door the failure is summarized at: a failed `commit` reached the
   * client library's transaction runner as the vendor threw it, anything else as one masked line
   * — which decides where a retry signal is looked for (THE RETRY LAW, SpannerFailureText).
   */
  constructor(
    readonly operation: SpannerOperationKind,
    readonly statement: StatementShape,
    vendorError: unknown,
    callSiteStack?: string,
    boundValues?: { [param: string]: unknown }
  ) {
    const summary = SpannerFailureText.summarize(
      vendorError,
      boundValues,
      operation === 'commit' ? 'commit' : 'statement'
    );
    super('SpannerOperationError', SpannerOperationError.describe(operation, statement, summary), vendorError);
    Object.setPrototypeOf(this, SpannerOperationError.prototype);
    if (summary.code !== undefined) {
      this.code = summary.code;
      this.status = summary.status;
    }
    this.failureClass = summary.failureClass;
    SpannerOperationError.SUMMARIES.set(this, summary);
    if (callSiteStack) {
      this.stack = `${this.name}: ${this.message}\n${callSiteStack}`;
    }
  }

  /** The backend's retry delay (gRPC `RetryInfo`), when it sent one — what a transaction runner backs off by. */
  get metadata(): unknown {
    const metadata = (this.vendorError() as { metadata?: Partial<VendorMetadata> } | null | undefined)?.metadata;
    if (
      typeof metadata?.clone !== 'function' ||
      typeof metadata.getMap !== 'function' ||
      typeof metadata.remove !== 'function'
    ) {
      return undefined;
    }
    const retryInfoOnly = metadata.clone();
    for (const key of Object.keys(retryInfoOnly.getMap())) {
      if (key !== RETRY_INFO_KEY) {
        retryInfoOnly.remove(key);
      }
    }
    return retryInfoOnly;
  }

  /** The underlying failure as a log line carries it: code, status, class and the driver's sentence. */
  causeSummary(): OperationCauseSummary {
    return { ...(SpannerOperationError.SUMMARIES.get(this) as OperationCauseSummary) };
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

  private static describe(
    operation: SpannerOperationKind,
    statement: StatementShape,
    summary: OperationCauseSummary
  ): string {
    const status = summary.status ? ` (${summary.status}, code ${summary.code})` : '';
    const target = statement.table ? `${statement.operation} ${statement.table}` : statement.operation;
    // A statement has a verb and a table worth naming; a commit and a schema update do not.
    const on = operation === 'query' || operation === 'dml' ? ` on ${target}` : '';
    return `Failed when executing ${operation}${status}${on}: ${summary.message}`;
  }
}
