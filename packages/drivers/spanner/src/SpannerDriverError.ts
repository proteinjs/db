/**
 * Each typed error's vendor error — held beside the instance, never on it, and not on the class
 * either: nothing an inspection can walk from an error (its own properties, its prototype chain,
 * a getter it runs) reaches this map.
 */
const VENDOR_ERRORS = new WeakMap<SpannerDriverError, unknown>();

/**
 * The base of the typed errors the driver throws in a vendor error's place (`SpannerOperationError`,
 * `SpannerEnvTokenAuthError`) — the ONE owner of how the vendor error rides along.
 *
 * The vendor error is `vendorError()`: for a caller that asks for it by name, and for nothing else.
 * It is deliberately NOT the standard `cause`: whatever prints an error follows `cause` whether or
 * not it is enumerable (`util.inspect` — so `console.*` and any log writer built on it — appends
 * `[cause]`; error reporters and generic handlers walk `error.cause.message`), and a vendor error's
 * `message`, `details` and trailers can quote whatever the backend choked on. It is not a property
 * of the instance, and it is a METHOD, never an accessor: no serializer and no own-property walk
 * reaches it, and a printer that runs getters — `util.inspect(error, { customInspect: false,
 * showHidden: true, getters: true })` walks the prototype's accessors and prints what they return
 * — finds a function, which no printer calls.
 */
export abstract class SpannerDriverError extends Error {
  protected constructor(name: string, message: string, vendorError: unknown) {
    super(message);
    this.name = name;
    VENDOR_ERRORS.set(this, vendorError);
  }

  /** The vendor error itself — raw; its `message` and `details` can quote row values. */
  vendorError(): unknown {
    return VENDOR_ERRORS.get(this);
  }

  /**
   * What `util.inspect` prints for this error — so what `console.*` and any log writer built on it
   * (the default dev writer) print: the stack and the enumerable facts, nothing else, the same
   * under every option that honours a custom rendering.
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
