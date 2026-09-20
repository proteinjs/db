/**
 * The base of the typed errors the driver throws in a vendor error's place (`SpannerOperationError`,
 * `SpannerEnvTokenAuthError`) — the ONE owner of how the vendor error rides along.
 *
 * The vendor error is `vendorError`: for a caller that asks for it by name, and for nothing else.
 * It is deliberately NOT the standard `cause`: whatever prints an error follows `cause` whether or
 * not it is enumerable (`util.inspect` — so `console.*` and any log writer built on it — appends
 * `[cause]`; error reporters and generic handlers walk `error.cause.message`), and a vendor error's
 * `message`, `details` and trailers can quote whatever the backend choked on. It is not a property
 * of the instance at all (an accessor on the prototype over a private map), so no serializer and no
 * own-property walk reaches it, and the error renders itself under `util.inspect`, whatever the
 * options.
 */
export abstract class SpannerDriverError extends Error {
  /** Each error's vendor error — held beside the instance, never on it (see the class doc). */
  private static readonly VENDOR_ERRORS = new WeakMap<SpannerDriverError, unknown>();

  protected constructor(name: string, message: string, vendorError: unknown) {
    super(message);
    this.name = name;
    SpannerDriverError.VENDOR_ERRORS.set(this, vendorError);
  }

  /** The vendor error itself — raw; its `message` and `details` can quote row values. */
  get vendorError(): unknown {
    return SpannerDriverError.VENDOR_ERRORS.get(this);
  }

  /**
   * What `util.inspect` prints for this error — so what `console.*` and any log writer built on it
   * (the default dev writer) print: the stack and the enumerable facts, nothing else. The stock
   * rendering would not print `vendorError` either, but an inspection configured to show hidden
   * properties and run getters walks the prototype's accessors and would; this rendering is the
   * same under every option.
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
}
