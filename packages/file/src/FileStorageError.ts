/**
 * Why a byte operation failed — the closed set a caller branches on.
 *
 * - `not-found`: the stored bytes for that file id are not there.
 * - `precondition-failed`: the store refused a conditional write (the object changed underneath it).
 * - `forbidden`: the store refused the driver's credentials or permissions.
 * - `unavailable`: the store could not be reached or asked to be retried later.
 * - `unknown`: anything else.
 */
export type FileStorageErrorCode = 'not-found' | 'precondition-failed' | 'forbidden' | 'unavailable' | 'unknown';

/**
 * THE error a {@link FileStorageDriver} throws — the only thing that leaves a driver when a byte
 * operation fails.
 *
 * It carries three plain facts and nothing else: a {@link FileStorageErrorCode}, a one-line
 * message, and the HTTP status where the store speaks HTTP. It NEVER carries the store client's own
 * error object, nor anything hanging off one — a request config, a request, a response, headers, a
 * signed URL. A store client's error routinely holds the request it made, and that request holds
 * the driver's credentials (an `Authorization` header); an application that logs the error it
 * caught would write a live credential into its logs. The driver is the only party that talks to
 * the store, so the driver owns what its errors carry, and no caller has to know to strip one.
 *
 * Callers branch on `code` — through {@link FileStorageError.is} / {@link FileStorageError.isNotFound},
 * which read the error's shape rather than its prototype, so they hold across duplicate copies of
 * this package in one process.
 */
export class FileStorageError extends Error {
  private static readonly NAME = 'FileStorageError';
  private static readonly CODES: FileStorageErrorCode[] = [
    'not-found',
    'precondition-failed',
    'forbidden',
    'unavailable',
    'unknown',
  ];
  /** Free text that reaches a message is one line and bounded. */
  private static readonly MAX_DETAIL_CHARS = 300;

  readonly code: FileStorageErrorCode;
  /** The store's HTTP status, where it has one. */
  readonly status?: number;

  /**
   * @param code what went wrong, for callers to branch on
   * @param summary the driver's own words for the failed operation (e.g. `getFileData failed for file <id>`)
   * @param options.status the store's HTTP status, where it has one
   * @param options.detail the store's own message text — made plain (see {@link plain}) before it is kept
   */
  constructor(code: FileStorageErrorCode, summary: string, options?: { status?: number; detail?: unknown }) {
    super(FileStorageError.describe(code, summary, options));
    this.name = FileStorageError.NAME;
    Object.setPrototypeOf(this, FileStorageError.prototype);
    this.code = code;
    if (options?.status !== undefined) {
      this.status = options.status;
    }
  }

  /** Is this a driver's error? Read by shape, so it holds across duplicate copies of this package. */
  static is(error: unknown): error is FileStorageError {
    const candidate = error as { name?: unknown; code?: unknown } | null | undefined;
    return (
      candidate?.name === FileStorageError.NAME &&
      FileStorageError.CODES.includes(candidate.code as FileStorageErrorCode)
    );
  }

  /** The stored bytes for that file id are not there. */
  static isNotFound(error: unknown): boolean {
    return FileStorageError.is(error) && error.code === 'not-found';
  }

  /**
   * The code an HTTP status means. Drivers whose store speaks HTTP share this table so one status
   * never reads two ways.
   */
  static codeForStatus(status: number | undefined): FileStorageErrorCode {
    if (status === 404) {
      return 'not-found';
    }
    if (status === 412) {
      return 'precondition-failed';
    }
    if (status === 401 || status === 403) {
      return 'forbidden';
    }
    if (status === 408 || status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
      return 'unavailable';
    }
    return 'unknown';
  }

  private static describe(
    code: FileStorageErrorCode,
    summary: string,
    options?: { status?: number; detail?: unknown }
  ): string {
    const status = options?.status !== undefined ? ` (HTTP ${options.status})` : '';
    const detail = FileStorageError.plain(options?.detail);
    return `${summary}: ${code}${status}${detail ? ` — ${detail}` : ''}`;
  }

  /**
   * A store's message text made safe to keep: text only (an object is never read into it), one
   * line, bounded, with every URL's query string dropped (a signed URL's signature lives there)
   * and any bearer credential masked.
   */
  private static plain(detail: unknown): string {
    if (typeof detail !== 'string') {
      return '';
    }

    const oneLine = detail
      .replace(/\s+/g, ' ')
      .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/gi, '$1')
      .replace(/\b(bearer|basic)\s+\S+/gi, '$1 [masked]')
      .trim();
    return oneLine.length > FileStorageError.MAX_DETAIL_CHARS
      ? `${oneLine.slice(0, FileStorageError.MAX_DETAIL_CHARS)}…`
      : oneLine;
  }
}
