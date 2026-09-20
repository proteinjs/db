/**
 * The ONE owner of the dev-only switch that lets the driver's failure line carry the REAL values
 * of a statement's bound parameters, and of the fields that carry them.
 *
 * By default the line carries no bound value: the parameters are described
 * (KnexDriver.describeParams — positions, kinds, lengths) and the failure is summarized by the
 * vendor's codes and the server's own message — never by the vendor error itself, whose `message`
 * the query layer rewrites to the SQL with every binding INTERPOLATED (and whose `sql` is the
 * same text). A parameter is row content, and a log line outlives and out-travels the row it came
 * from. A local dev database holds nothing that needs that protection, and there the values are
 * what locates a bug. So the switch: when BOTH `DEVELOPMENT` is set (the dev-server switch, never
 * set in a production image) AND `DB_LOG_PARAM_VALUES=1`, the line adds `paramValues` — the
 * parameters as they were bound — and carries the vendor error itself as `error`. With either
 * unset: never. Both are read at each line, so a process cannot hold a stale answer.
 *
 * The switch adds FIELDS to a log line and changes nothing else: what the driver throws is the
 * same with the switch on or off.
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

  /** What a failure's line carries beside its cause summary: the vendor error itself as `{ error }`, or nothing. */
  static ofFailure(error: unknown): { error?: unknown } {
    return KnexLogValues.enabled() ? { error } : {};
  }
}
