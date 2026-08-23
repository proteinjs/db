/**
 * The proxy route's Range arithmetic (RFC 7233 single byte-range), separated pure so the
 * route's seek behavior is hermetically testable:
 *
 * - `undefined` — no (usable) range was asked: serve the whole body as 200. Covers a missing
 *   header, a non-`bytes` unit, malformed specs, and multi-range requests (a `<video>` never
 *   sends them; the RFC lets a server ignore an unusable Range header entirely).
 * - `'unsatisfiable'` — a syntactically-valid range that selects nothing (start past EOF, an
 *   empty suffix, or any range of a zero-byte body): respond 416 with a `Content-Range` naming the size (`bytes * / size`).
 * - `{ start, end }` — serve 206 with `bytes start-end/size` and exactly those bytes
 *   (inclusive). An over-long end clamps to the last byte.
 */
export function resolveByteRange(
  rangeHeader: string | undefined,
  size: number
): { start: number; end: number } | 'unsatisfiable' | undefined {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
    return undefined;
  }
  const spec = rangeHeader.slice('bytes='.length).trim();
  if (spec.includes(',')) {
    return undefined; // multi-range — serve whole (no player sends these)
  }
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (match[1] === '' && match[2] === '')) {
    return undefined; // malformed — ignore the header per the RFC
  }
  const [, fromText, toText] = match;
  if (fromText === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(toText);
    if (suffix === 0 || size === 0) {
      return 'unsatisfiable';
    }
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(fromText);
  if (start >= size) {
    return 'unsatisfiable';
  }
  if (toText === '') {
    return { start, end: size - 1 };
  }
  const end = Number(toText);
  if (end < start) {
    return undefined; // malformed (last < first) — ignore the header per the RFC
  }
  return { start, end: Math.min(end, size - 1) };
}
