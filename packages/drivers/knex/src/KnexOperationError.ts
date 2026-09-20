/** The failure as a log line carries it: the error's name and the vendor's codes — never its text. */
export type KnexOperationCauseSummary = { name?: string; code?: string; errno?: number; sqlState?: string };

/**
 * A failed statement or schema operation — what `KnexDriver` and `KnexSchemaOperations` throw when
 * the query layer rejects. The ONE owner of what a vendor failure may say on this driver.
 *
 * The vendor error is NOT safe to print: the query layer rewrites a failed query's `message` to
 * the SQL with its bindings INTERPOLATED, the client library's error carries the same formatted
 * text as `sql`, and its `sqlMessage` quotes the offending key (`Duplicate entry '<value>' for key
 * …` — a ROW value when a unique index is built over duplicate rows) — every bound value of the
 * statement, in any log line the error reaches. So nothing of the vendor's text is kept: this
 * error's message, stack and enumerable properties name what failed in the driver's words and the
 * vendor's CODES (`ER_DUP_ENTRY`, errno 1062), which are copied so callers keep branching on them.
 *
 * The vendor error itself is `vendorError` — for a caller that asks for it by name, and for
 * nothing else. It is deliberately NOT the standard `cause`: whatever prints an error follows
 * `cause` whether or not it is enumerable (`util.inspect` — so `console.*` and any log writer built
 * on it — appends `[cause]`; error reporters and generic handlers walk `error.cause.message`). It
 * is not a property of the instance at all (an accessor on the prototype over a private map), so
 * no serializer and no own-property walk reaches it, and the error renders itself under
 * `util.inspect`, whatever the options.
 */
export class KnexOperationError extends Error {
  /** Each error's vendor error — held beside the instance, never on it (see the class doc). */
  private static readonly VENDOR_ERRORS = new WeakMap<KnexOperationError, unknown>();
  readonly code?: string;
  readonly errno?: number;
  readonly sqlState?: string;

  /** @param what what failed, in the driver's words — never a value (`Failed to create table: <name>`). */
  constructor(vendorError: unknown, what = 'Failed when executing sql') {
    super(KnexOperationError.describe(vendorError, what));
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
    KnexOperationError.VENDOR_ERRORS.set(this, vendorError);
  }

  /** The vendor error itself — raw; its `message`, `sql` and `sqlMessage` quote bound and row values. */
  get vendorError(): unknown {
    return KnexOperationError.VENDOR_ERRORS.get(this);
  }

  /** The underlying failure as a log line carries it. */
  causeSummary(): KnexOperationCauseSummary {
    return KnexOperationError.summarize(this.vendorError);
  }

  /**
   * What `util.inspect` prints for this error: the stack and the enumerable facts, nothing else.
   * The stock rendering would not print `vendorError` either, but an inspection configured to show
   * hidden properties and run getters walks the prototype's accessors and would; this rendering is
   * the same under every option.
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
   * The name and codes of any thrown value — the facts about a failure that are never row content.
   * Each is kept only in the vendor's own CONSTANT form (an error class name, `ER_DUP_ENTRY`, a
   * five-character SQLSTATE); a field carrying anything else is free text, and is dropped.
   */
  static summarize(cause: unknown): KnexOperationCauseSummary {
    const vendor = cause as { name?: unknown; code?: unknown; errno?: unknown; sqlState?: unknown } | null | undefined;
    const constant = (field: unknown, form: RegExp): string | undefined =>
      typeof field === 'string' && form.test(field) ? field : undefined;
    const name = constant(vendor?.name, /^[A-Za-z]{1,64}$/);
    const code = constant(vendor?.code, /^[A-Z][A-Z0-9_]{1,63}$/);
    const sqlState = constant(vendor?.sqlState, /^[0-9A-Z]{5}$/);
    return {
      ...(name !== undefined ? { name } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(typeof vendor?.errno === 'number' ? { errno: vendor.errno } : {}),
      ...(sqlState !== undefined ? { sqlState } : {}),
    };
  }

  private static describe(cause: unknown, what: string): string {
    const { name, code, errno } = KnexOperationError.summarize(cause);
    const facts = [code ?? name, errno !== undefined ? `errno ${errno}` : undefined].filter(Boolean).join(', ');
    return facts ? `${what} (${facts})` : what;
  }
}
