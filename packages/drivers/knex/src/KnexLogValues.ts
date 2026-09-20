import { KnexOperationError } from './KnexOperationError';

/**
 * The ONE owner of the dev-only switch that lets the driver's lines carry REAL values, and of the
 * fields that carry them.
 *
 * By default no line the driver writes carries a bound value or the vendor's own message: the
 * parameters are described (KnexDriver.describeParams) and a failure is named by its codes
 * (KnexOperationError), because a log line outlives and out-travels the row it came from. A local
 * dev database holds nothing that needs that protection, and there the values are what locates a
 * bug. So the switch: when BOTH `DEVELOPMENT` is set (the dev-server switch, never set in a
 * production image) AND `DB_LOG_PARAM_VALUES=1`, a failed statement's line adds `paramValues` — the
 * parameters as they were bound — and `vendorMessage` — the vendor's message as it arrived (the
 * SQL with its bindings interpolated, and the server's own words). With either unset: never. Both
 * are read at each line, so a process cannot hold a stale answer.
 *
 * The switch adds FIELDS to log lines and changes nothing else: the typed error's message, stack
 * and properties stay value-free, so what a caller catches is the same with the switch on or off.
 */
export class KnexLogValues {
  /** The dev-server switch: the first gate. */
  static readonly DEVELOPMENT_VAR = 'DEVELOPMENT';
  /** The values switch: the second gate, on only as exactly `1`. */
  static readonly SWITCH_VAR = 'DB_LOG_PARAM_VALUES';

  /** Whether lines may carry real values right now — both gates, read now. */
  static enabled(): boolean {
    return !!process.env[KnexLogValues.DEVELOPMENT_VAR] && process.env[KnexLogValues.SWITCH_VAR] === '1';
  }

  /** What a statement's line adds beside its described parameters: `{ paramValues }`, or nothing. */
  static ofStatement(params: readonly unknown[] | undefined): { paramValues?: readonly unknown[] } {
    return KnexLogValues.enabled() && params ? { paramValues: params } : {};
  }

  /**
   * What a failure's line adds beside its cause summary: `{ vendorMessage }` — the vendor's own
   * message, read off the vendor error (behind the typed error's `vendorError()`) — or nothing.
   */
  static ofFailure(failure: unknown): { vendorMessage?: string } {
    if (!KnexLogValues.enabled()) {
      return {};
    }
    const vendor = failure instanceof KnexOperationError ? failure.vendorError() : failure;
    const message = typeof vendor === 'string' ? vendor : (vendor as { message?: unknown } | null | undefined)?.message;
    return typeof message === 'string' ? { vendorMessage: message } : {};
  }
}
