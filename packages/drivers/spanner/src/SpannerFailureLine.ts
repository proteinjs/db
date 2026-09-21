import { ErrorLine, LogLineErrors } from '@proteinjs/logger';
import { GRPC_STATUS_NAMES, OperationCauseSummary, SpannerOperationError } from './SpannerOperationError';
import { SpannerLogValues } from './SpannerLogValues';

/**
 * A failure as the driver's own line carries it under `cause`: the status, and as `message` the
 * driver's sentence for it. The field NAMES are what readers of the line parse (an error-report
 * pipeline reads `cause.code`, `cause.status` and `cause.message`): they do not change — what
 * `message` holds does.
 */
export type FailureCause = Pick<OperationCauseSummary, 'code' | 'status' | 'message'>;

/**
 * The ONE owner of how a failure of the backend reads on a LOG LINE: its gRPC status and a
 * sentence of the driver's own — never the backend's message.
 *
 * The backend words its errors itself, and quotes the value it choked on, often bare (`Could not
 * parse <value> as a TIMESTAMP`, `Bad int64 value: <value>`), where no mask can find it. That
 * text stays on what the driver THROWS, exactly as it always was: the client library's
 * transaction runner decides its retries by reading a thrown error's message, so the thrown
 * error is nobody's to rewrite. What changes is what is PRINTED. Every failure that leaves the
 * driver — the typed operation error, the vendor error under it, a failed commit, rollback or
 * schema update, the runner's budget error — is marked with the logger (`mark`), which never
 * touches the error; from then on any line about it, the driver's or a caller's, carries the
 * status and the sentence in place of the error's own text.
 *
 * The backend's text rides a line only behind the dev-only values switch (SpannerLogValues —
 * what the backend echoes IS a bound value): with both gates open a marked error prints as it
 * is, and `causeOf` carries the backend's message as its `message`. Asked at each line, like the
 * switch itself.
 *
 * An error the DRIVER worded itself (its own op deadline) quotes nothing of the backend's: it is
 * declared (`driverWorded`), and neither it nor the typed error that wraps it is ever marked —
 * a line about it says what the driver said.
 */
export class SpannerFailureLine {
  private static readonly DRIVER_WORDED = new WeakSet<object>();
  private static readonly NO_STATUS = 'the failure carried no status code';
  private static readonly SENTENCES: { [code: number]: string } = {
    1: 'the call was cancelled',
    2: 'the database reported a failure it did not classify',
    3: 'the database rejected the statement or a value bound to it',
    4: 'the call did not finish within its deadline',
    5: 'something the statement names was not found (a table, a column, an index, a row or a session)',
    6: 'what the statement creates already exists (a row with that key, or a schema object)',
    7: 'the caller is not permitted to do this',
    8: 'a quota or a limit of the database was exhausted',
    9: 'the statement cannot run against the database as it stands',
    10: 'the transaction was aborted',
    11: 'a value is out of range or does not convert',
    12: 'the database does not support this',
    13: 'the database or the connection to it failed internally',
    14: 'the database could not be reached',
    15: 'the database reported data loss',
    16: 'the credentials of the caller were not accepted',
  };

  /**
   * Marks `error` — anything the backend or the client library rejected with, or an error of the
   * driver's own that carries such text — as never printing its own text, and answers the same
   * error. `what` is the driver's words for what failed (`Transaction commit failed`); a typed
   * operation error says it itself (its operation, its statement's verb and table). The status
   * is read off `statusFrom` — the error itself, unless it translates another (the env-token
   * auth error carries no code of its own). The FIRST door an error leaves through knows it
   * best: an error already marked keeps its line.
   */
  static mark<T>(error: T, what?: string, statusFrom: unknown = error): T {
    if (!SpannerFailureLine.isDriverWorded(error) && !LogLineErrors.isMarked(error)) {
      LogLineErrors.mark(error, () =>
        SpannerLogValues.enabled() ? undefined : SpannerFailureLine.lineOf(error, what, statusFrom)
      );
    }
    return error;
  }

  /**
   * Declares `error` worded by the driver itself — nothing of the backend's is in it — and
   * answers the same error: `mark` leaves it, and a typed operation error whose cause it is, to
   * print as they are.
   */
  static driverWorded<T extends object>(error: T): T {
    SpannerFailureLine.DRIVER_WORDED.add(error);
    return error;
  }

  /**
   * The failure as the driver's own line carries it under `cause`: the status, and as `message`
   * the driver's sentence — behind the values switch, the backend's own message in its place.
   */
  static causeOf(error: unknown): FailureCause {
    const code = SpannerFailureLine.codeOf(error);
    return {
      ...(code !== undefined ? { code, status: SpannerFailureLine.statusOf(code) } : {}),
      message: SpannerLogValues.enabled()
        ? SpannerOperationError.summarize(error).message
        : SpannerFailureLine.sentenceOf(code),
    };
  }

  private static lineOf(error: unknown, what: string | undefined, statusFrom: unknown): ErrorLine {
    const code = SpannerFailureLine.codeOf(statusFrom);
    const status = code !== undefined ? SpannerFailureLine.statusOf(code) : undefined;
    const sentence = SpannerFailureLine.sentenceOf(code);
    if (error instanceof SpannerOperationError) {
      return {
        code,
        sentence: `${SpannerOperationError.headline(error.operation, error.statement, error)}: ${sentence}`,
        facts: { ...(status !== undefined ? { status } : {}), operation: error.operation, statement: error.statement },
      };
    }
    const named = status !== undefined ? ` (${status}, code ${code})` : '';
    return {
      code,
      sentence: `${what ?? 'The database call failed'}${named}: ${sentence}`,
      ...(status !== undefined ? { facts: { status } } : {}),
    };
  }

  private static isDriverWorded(error: unknown): boolean {
    const worded = (each: unknown) =>
      typeof each === 'object' && each !== null && SpannerFailureLine.DRIVER_WORDED.has(each);
    return worded(error) || (error instanceof SpannerOperationError && worded(error.cause));
  }

  private static codeOf(error: unknown): number | undefined {
    try {
      const code = (error as { code?: unknown } | null | undefined)?.code;
      return typeof code === 'number' ? code : undefined;
    } catch {
      return undefined;
    }
  }

  private static statusOf(code: number): string {
    return GRPC_STATUS_NAMES[code] ?? `code ${code}`;
  }

  private static sentenceOf(code: number | undefined): string {
    return code === undefined
      ? SpannerFailureLine.NO_STATUS
      : (SpannerFailureLine.SENTENCES[code] ?? 'the database answered with a status this driver does not name');
  }
}
