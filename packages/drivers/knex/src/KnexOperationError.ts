/** The failure as a log line carries it: the error's name and the vendor's codes — never its text. */
export type KnexOperationCauseSummary = { name?: string; code?: string; errno?: number; sqlState?: string };

/**
 * A failed statement — what `KnexDriver.runQuery` / `runDml` throw when the query layer rejects.
 *
 * The vendor error is NOT safe to print: the query layer rewrites a failed query's `message` to
 * the SQL with its bindings INTERPOLATED, the client library's error carries the same formatted
 * text as `sql`, and its `sqlMessage` quotes the offending key — every bound value of the
 * statement, in any log line the error reaches. This error's message, stack and enumerable
 * properties carry none of it: the message names the vendor's code (`ER_DUP_ENTRY`, errno 1062),
 * and the codes are copied so callers keep branching on them. The vendor error itself rides as
 * `vendorError` for callers — NOT enumerable, and deliberately NOT the standard `cause`: whatever
 * prints an error follows `cause` whether or not it is enumerable (`util.inspect` — so `console.*`
 * and any log writer built on it — appends `[cause]`; error reporters walk the chain), and this
 * vendor error is value-laden through and through.
 */
export class KnexOperationError extends Error {
  readonly code?: string;
  readonly errno?: number;
  readonly sqlState?: string;
  /** The vendor error itself — for callers; not enumerable: its message and `sql` quote the bound values. */
  readonly vendorError: unknown;

  constructor(vendorError: unknown) {
    super(KnexOperationError.describe(vendorError));
    this.name = 'KnexOperationError';
    Object.setPrototypeOf(this, KnexOperationError.prototype);
    const summary = KnexOperationError.summarize(vendorError);
    if (summary.code !== undefined) {
      this.code = summary.code;
    }
    if (summary.errno !== undefined) {
      this.errno = summary.errno;
    }
    if (summary.sqlState !== undefined) {
      this.sqlState = summary.sqlState;
    }
    Object.defineProperty(this, 'vendorError', { value: vendorError, enumerable: false, writable: false });
  }

  /** The underlying failure as a log line carries it. */
  causeSummary(): KnexOperationCauseSummary {
    return KnexOperationError.summarize(this.vendorError);
  }

  /** The name and codes of any thrown value — the facts about a failure that are never row content. */
  static summarize(cause: unknown): KnexOperationCauseSummary {
    const vendor = cause as { name?: unknown; code?: unknown; errno?: unknown; sqlState?: unknown } | null | undefined;
    return {
      ...(typeof vendor?.name === 'string' ? { name: vendor.name } : {}),
      ...(typeof vendor?.code === 'string' ? { code: vendor.code } : {}),
      ...(typeof vendor?.errno === 'number' ? { errno: vendor.errno } : {}),
      ...(typeof vendor?.sqlState === 'string' ? { sqlState: vendor.sqlState } : {}),
    };
  }

  private static describe(cause: unknown): string {
    const { name, code, errno } = KnexOperationError.summarize(cause);
    const facts = [code ?? name, errno !== undefined ? `errno ${errno}` : undefined].filter(Boolean).join(', ');
    return facts ? `Failed when executing sql (${facts})` : 'Failed when executing sql';
  }
}
