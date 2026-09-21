import { ErrorLine, LogLineErrors } from '@proteinjs/logger';
import { KnexLogValues } from './KnexLogValues';

/**
 * A failure as the driver's own line carries it under `cause`: the error's name, the vendor's
 * codes and, as `message`, the driver's sentence — the field a reader of any driver's line parses.
 */
export type FailureCause = {
  name?: string;
  code?: string;
  errno?: number;
  sqlState?: string;
  message: string;
  /** The server's own message — behind the dev-only values switch, never otherwise. */
  sqlMessage?: string;
};

/**
 * The ONE owner of how a failure of the database reads on a LOG LINE: the vendor's codes and a
 * sentence of the driver's own — never the vendor's text.
 *
 * What the driver THROWS is the vendor's error itself, untouched, and it is not safe to print:
 * the query layer rewrites its `message` to the SQL with every binding INTERPOLATED, the client
 * library carries the same text as `sql`, and the server's own message (`sqlMessage`) quotes the
 * value it refused (`Duplicate entry '<key>' for key 'PRIMARY'`). The driver's own line never
 * carried the first two; a CALLER's line about the error it caught carried all three. So every
 * failure that leaves the driver is marked with the logger (`mark`), which never touches the
 * error; from then on any line about it, the driver's or a caller's, carries the codes and the
 * sentence in place of the error's own text.
 *
 * The vendor's text rides a line only behind the dev-only values switch (KnexLogValues): with
 * both gates open a marked error prints as it is, and `causeOf` adds the server's message.
 * Asked at each line, like the switch itself.
 */
export class KnexFailureLine {
  private static readonly UNNAMED = 'the database refused the statement';
  private static readonly UNREACHABLE = 'the database could not be reached';
  private static readonly SENTENCES: { [code: string]: string } = {
    ER_DUP_ENTRY: 'a row with that key already exists',
    ER_NO_SUCH_TABLE: 'a table the statement names does not exist',
    ER_BAD_FIELD_ERROR: 'a column the statement names does not exist',
    ER_PARSE_ERROR: 'the statement does not parse',
    ER_LOCK_DEADLOCK: 'the transaction was chosen as a deadlock victim',
    ER_LOCK_WAIT_TIMEOUT: 'a lock wait timed out',
    ER_DATA_TOO_LONG: 'a value is longer than its column',
    ER_TRUNCATED_WRONG_VALUE: 'a value does not convert to the type of its column',
    ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: 'a value does not convert to the type of its column',
    ER_WARN_DATA_OUT_OF_RANGE: 'a value is out of range for its column',
    ER_BAD_NULL_ERROR: 'a column that cannot be null was given null',
    ER_NO_REFERENCED_ROW_2: 'a foreign key refused the statement',
    ER_ROW_IS_REFERENCED_2: 'a foreign key refused the statement',
    ER_ACCESS_DENIED_ERROR: 'the credentials of the caller were not accepted',
    ER_NET_PACKET_TOO_LARGE: 'the statement is larger than the server accepts',
    ECONNREFUSED: KnexFailureLine.UNREACHABLE,
    ECONNRESET: KnexFailureLine.UNREACHABLE,
    ETIMEDOUT: KnexFailureLine.UNREACHABLE,
    PROTOCOL_CONNECTION_LOST: KnexFailureLine.UNREACHABLE,
  };

  /**
   * Marks `error` — whatever the client library or the query layer rejected with — as never
   * printing its own text, and answers the same error. `what` is the driver's words for what
   * failed. An error already marked keeps its line.
   */
  static mark<T>(error: T, what: string): T {
    if (!LogLineErrors.isMarked(error)) {
      LogLineErrors.mark(error, () => (KnexLogValues.enabled() ? undefined : KnexFailureLine.lineOf(error, what)));
    }
    return error;
  }

  /**
   * The failure as the driver's own line carries it under `cause` — never the query layer's
   * rewritten `message` or `sql`, and the server's own message only behind the values switch.
   * Total: a fact that cannot be read is left out.
   */
  static causeOf(error: unknown): FailureCause {
    const name = KnexFailureLine.vendorFact(error, 'name');
    const code = KnexFailureLine.vendorFact(error, 'code');
    const errno = KnexFailureLine.vendorFact(error, 'errno');
    const sqlState = KnexFailureLine.vendorFact(error, 'sqlState');
    const sqlMessage = KnexLogValues.enabled() ? KnexFailureLine.vendorFact(error, 'sqlMessage') : undefined;
    return {
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof errno === 'number' ? { errno } : {}),
      ...(typeof sqlState === 'string' ? { sqlState } : {}),
      message: KnexFailureLine.sentenceOf(code),
      ...(typeof sqlMessage === 'string' ? { sqlMessage } : {}),
    };
  }

  private static lineOf(error: unknown, what: string): ErrorLine {
    const { name: _name, message, sqlMessage: _sqlMessage, ...codes } = KnexFailureLine.causeOf(error);
    const named = [codes.code, codes.errno !== undefined ? `errno ${codes.errno}` : undefined].filter(Boolean);
    return {
      ...(codes.code !== undefined ? { code: codes.code } : {}),
      sentence: `${what}${named.length ? ` (${named.join(', ')})` : ''}: ${message}`,
      facts: codes,
    };
  }

  private static sentenceOf(code: unknown): string {
    return (typeof code === 'string' ? KnexFailureLine.SENTENCES[code] : undefined) ?? KnexFailureLine.UNNAMED;
  }

  /** One fact of a thrown value, or nothing when it cannot be read (nothing thrown, a scalar, a throwing accessor). */
  private static vendorFact(error: unknown, fact: string): unknown {
    try {
      return (error as { [fact: string]: unknown } | null | undefined)?.[fact];
    } catch {
      return undefined;
    }
  }
}
