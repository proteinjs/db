import moment from 'moment';

/**
 * A value that IS structure — an object or an array — whatever its column claims to be. The
 * record surfaces decide a structured presentation by the VALUE's shape as well as the column's
 * class, because the registry types some structured columns outside @proteinjs/db (a driver's
 * JSON column) and a class check alone let those fall to `value.toString()` — the `[object
 * Object]` an admin saw in a column (founder, R7 round 3). Times (moments, Dates) are objects
 * too and are excluded: they have their own presentations. Reference shapes (`_table`/`_id`)
 * are objects as well; the callers test those FIRST, since they present as links, not content.
 */
export function isStructuredValue(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !moment.isMoment(value) && !(value instanceof Date);
}
