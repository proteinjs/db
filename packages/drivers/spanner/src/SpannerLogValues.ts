/**
 * The ONE owner of the dev-only switch that lets the driver's statement lines carry the REAL
 * values of a statement's bound parameters, and of the field that carries them.
 *
 * By default no line the driver writes about a statement carries a bound value: the parameters
 * are described (SpannerDriver.describeParams — names, types, lengths), because a parameter is
 * row content and a log line outlives and out-travels the row it came from. An emulator or a
 * local dev database holds nothing that needs that protection, and there the values are what
 * locates a bug. So the switch: when BOTH `DEVELOPMENT` is set (the dev-server switch, never set
 * in a production image) AND `DB_LOG_PARAM_VALUES=1`, a statement's lines add `paramValues` — the
 * parameters as they were bound — beside the description, which stays. With either unset: never.
 * Both are read at each line, so a process cannot hold a stale answer.
 *
 * The switch adds a FIELD to log lines and changes nothing else: what the driver throws is the
 * same with the switch on or off.
 */
export class SpannerLogValues {
  /** The dev-server switch: the first gate. */
  static readonly DEVELOPMENT_VAR = 'DEVELOPMENT';
  /** The values switch: the second gate, on only as exactly `1`. */
  static readonly SWITCH_VAR = 'DB_LOG_PARAM_VALUES';

  /** Whether lines may carry real values right now — both gates, read now. */
  static enabled(): boolean {
    return !!process.env[SpannerLogValues.DEVELOPMENT_VAR] && process.env[SpannerLogValues.SWITCH_VAR] === '1';
  }

  /** What a statement's line adds beside its described parameters: `{ paramValues }`, or nothing. */
  static ofStatement(params: { [param: string]: unknown } | undefined): { paramValues?: { [param: string]: unknown } } {
    return SpannerLogValues.enabled() && params ? { paramValues: params } : {};
  }
}
