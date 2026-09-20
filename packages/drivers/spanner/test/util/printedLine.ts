import { inspect } from 'util';

/** A log entry as a capturing log writer receives it. */
export type CapturedLog = { logLevel: string; message?: string; obj?: any; error?: any };

/**
 * An error as ANYTHING that prints errors would print it — what a value must never be found in:
 * its message and stack; its `util.inspect` rendering, stock (the default dev log writer,
 * `console.*`), with hidden properties shown and getters run, and the same with the error's own
 * rendering switched OFF (`customInspect: false` — the raw object walk, which runs every accessor
 * on the prototype chain); its serialized form (a structured writer); the standard `cause` chain an
 * error reporter walks, message and `details` at each link; and every own property of the error,
 * enumerable or not.
 */
export const printed = (error: any): string => {
  const parts: string[] = [
    String(error?.message),
    String(error?.stack),
    inspect({ error }, { depth: 10, maxStringLength: null }),
    inspect(error, { depth: 10, maxStringLength: null, showHidden: true, getters: true }),
    inspect(error, { depth: 10, maxStringLength: null, showHidden: true, getters: true, customInspect: false }),
    JSON.stringify(error) ?? '',
  ];
  for (let link = error?.cause, depth = 0; link && depth < 5; link = link.cause, depth++) {
    parts.push(String(link.message), String(link.details), inspect(link, { depth: 10, maxStringLength: null }));
  }
  if (error && typeof error === 'object') {
    for (const name of Object.getOwnPropertyNames(error)) {
      parts.push(inspect(error[name], { depth: 10, maxStringLength: null }));
    }
  }
  return parts.join('\n');
};

/** The text a log writer would print for a captured line. */
export const lineOf = (log: CapturedLog): string =>
  [
    log.logLevel,
    log.message ?? '',
    inspect(log.obj, { depth: 10, maxStringLength: null, maxArrayLength: null }),
    JSON.stringify(log.obj) ?? '',
    log.error ? printed(log.error) : '',
  ].join('\n');
