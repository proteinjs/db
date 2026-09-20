/** gRPC status names by code — what a vendor error's `code` means, spelled for humans and logs. */
export const GRPC_STATUS_NAMES: { [code: number]: string } = {
  0: 'OK',
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
};

/**
 * A failure as a log line and an error message carry it: the gRPC code, its name, the CLASS the
 * driver recognized it as, and the driver's own sentence for that class. Never the backend's text.
 */
export type OperationCauseSummary = { code?: number; status?: string; failureClass: string; message: string };

/** The values bound to the failed statement, by parameter name — what the backend may echo. */
type BoundValues = { [param: string]: unknown } | undefined;

/**
 * One recognized class of backend failure. `codes` are the gRPC codes it is recognized under
 * (`undefined` = an error with no code); `patterns` run against the backend's message with the
 * status prefix stripped and every bound value struck out; `phrase` is the driver's sentence.
 */
type FailureClass = {
  name: string;
  codes: (number | undefined)[];
  patterns: RegExp[];
  phrase: (match: RegExpExecArray) => string;
};

/**
 * The ONE owner of what a backend failure may SAY — in a log line at any level, in the message and
 * stack of an error the driver throws, for a data op, a schema update and a liveness probe alike.
 *
 * The backend's own message is never printed. It echoes whatever value it choked on, and no mask
 * over that text is sound: a key arrives quoted and braced (`primary key ({pk#id:"…"})`), a bind
 * that does not parse arrives BARE (`Could not parse <value> as a TIMESTAMP`, `Bad int64 value:
 * <value>`), an index backfill prints the duplicate ROW value, an abort names a key range, and
 * `ERROR(<expression>)` makes the entire message data. So this is an allow-list, not a mask: a
 * failure is RECOGNIZED as one of a closed set of classes — by its gRPC code and the fixed text
 * the message opens with — and the line carries the driver's sentence for that class, beside the
 * code and status. An unrecognized failure carries the sentence for its code, or says that its
 * message is withheld. The raw vendor error stays reachable for a caller that asks for it by name
 * (`SpannerOperationError.vendorError`); nothing that prints an error reaches it.
 *
 * What a sentence may keep of the backend's text is SCHEMA, never data: an identifier (an index,
 * a column, a constraint, a table) or a number the backend computed (a size, a limit, a position
 * in the SQL). Three rules make that sound:
 *  - a kept token is read from a fixed position at the START of the message, before any position
 *    where the backend prints a value;
 *  - a class recognized under OUT_OF_RANGE keeps nothing — that is the code `ERROR()` raises, and
 *    under it the whole message can be row data;
 *  - before anything is recognized, every occurrence of every bound value is struck out of the
 *    message (strikeBoundValues), in each form the backend echoes it — so a token that IS a bound
 *    value can never be kept, whatever the message looks like.
 *
 * The driver's own errors (the op deadline, the env-token auth error) are authored here or
 * registered here (houseError / markHouseAuthored): their text is the driver's, and is kept.
 *
 * Two vendor predicates read the MESSAGE of the error a transaction body throws — the client
 * library's runner decides a retry on `message.includes('Session not found')` and on four
 * stream-reset literals — so those two classes' sentences repeat the literal (from this file,
 * never from the message) and the runner keeps retrying what it retried before.
 */
export class SpannerFailureText {
  /** The class name `SpannerSchemaOperations.isAlreadyExistsError` keys on. */
  static readonly SCHEMA_OBJECT_ALREADY_EXISTS = 'schema object already exists';
  /** Struck-out bound values read as this; no pattern below can match across it. */
  private static readonly STRUCK = '\u0000';
  /** A kept identifier: word characters and dots, bounded. */
  private static readonly IDENTIFIER = '([\\w.]{1,128})';
  /** Errors whose text the driver wrote itself (see houseError / markHouseAuthored). */
  private static readonly HOUSE_AUTHORED = new WeakSet<object>();
  /** The stream-reset literals the client library's transaction runner retries on (INTERNAL). */
  private static readonly RETRYABLE_STREAM_RESETS = [
    'Received unexpected EOS on DATA frame from server',
    'RST_STREAM',
    'HTTP/2 error code: INTERNAL_ERROR',
    'Connection closed with unknown cause',
  ];

  private static readonly CODE_PHRASES: { [code: number]: string } = {
    1: 'the call was cancelled',
    2: 'the backend reported an unknown error',
    3: 'the backend rejected the statement or a bound value as invalid',
    4: 'the backend did not answer within the call deadline',
    5: 'something the statement needs (a table, a row, a session, a database) was not found',
    6: 'the row or object already exists',
    7: 'the caller lacks permission for the operation',
    8: 'a backend quota or resource is exhausted',
    9: 'a precondition failed (a constraint, a parameter type, or the state of the database)',
    10: 'the transaction was aborted (a lock conflict with a concurrent transaction)',
    11: 'a value is out of range or does not convert (a cast, a parse, arithmetic, or a check over row data)',
    12: 'the backend does not implement the operation',
    13: 'the backend reported an internal error',
    14: 'the backend is unavailable',
    15: 'the backend reported data loss',
    16: 'the backend rejected the credentials',
  };

  private static readonly CLASSES: FailureClass[] = [
    // ── rows ──────────────────────────────────────────────────────────────────────────────────
    {
      name: 'row already exists',
      codes: [6],
      patterns: [/^Failed to insert row with primary key/i, /^Row \[/i],
      phrase: () => 'a row with this primary key already exists',
    },
    {
      name: 'unique index violation',
      codes: [6],
      patterns: [
        new RegExp(`^UNIQUE violation on index ${SpannerFailureText.IDENTIFIER},`, 'i'),
        new RegExp(`^Unique index violation on index ${SpannerFailureText.IDENTIFIER} at index key`, 'i'),
      ],
      phrase: (match) => `a unique index already holds this key (index ${SpannerFailureText.identifier(match[1])})`,
    },
    {
      name: 'value exceeds column size',
      codes: [9],
      patterns: [
        new RegExp(
          `^New value exceeds the maximum size limit for this column[^:]{0,40}: ${SpannerFailureText.IDENTIFIER}, size: (\\d{1,12}), limit: (\\d{1,12})`
        ),
      ],
      phrase: (match) =>
        `a value exceeds its column's size limit (column ${SpannerFailureText.identifier(match[1])}, size ${match[2]}, limit ${match[3]})`,
    },
    {
      name: 'null in required column',
      codes: [9],
      patterns: [
        new RegExp(`^Cannot specify a null value for column: ${SpannerFailureText.IDENTIFIER} in table: `),
        new RegExp(
          `^A new row in table [\\w.]{1,128} does not specify a non-null value for (?:these )?NOT NULL columns?: ${SpannerFailureText.IDENTIFIER}`
        ),
      ],
      phrase: (match) => `a NOT NULL column was given no value (column ${SpannerFailureText.identifier(match[1])})`,
    },
    {
      name: 'foreign key violation',
      codes: [9],
      patterns: [
        new RegExp(
          `^Foreign key \`?${SpannerFailureText.IDENTIFIER}\`? constraint violation on table \`?${SpannerFailureText.IDENTIFIER}\`?\\.`
        ),
        new RegExp(
          `^Foreign key constraint \`?${SpannerFailureText.IDENTIFIER}\`? is violated on table \`?${SpannerFailureText.IDENTIFIER}\`?\\.`
        ),
      ],
      phrase: (match) =>
        `a foreign key rejected the row (constraint ${SpannerFailureText.identifier(match[1])} on table ${SpannerFailureText.identifier(match[2])})`,
    },
    {
      // OUT_OF_RANGE: nothing of the message is kept (see the class doc).
      name: 'check constraint violation',
      codes: [9, 11],
      patterns: [/^Check constraint /],
      phrase: () => 'a check constraint rejected the row',
    },
    {
      name: 'bound value does not parse',
      codes: [3, 9],
      patterns: [/^Could not parse /, /^Invalid value for bind parameter /],
      phrase: () => 'a bound value does not parse as the type its parameter declares',
    },
    {
      // The exact-mode JSON parser's refusal of a number (see SpannerDriver.paramExpression).
      name: 'json number does not round-trip',
      codes: [11],
      patterns: [/cannot round-trip through string representation/],
      phrase: () =>
        "a JSON number cannot round-trip through string representation (bind JSON through PARSE_JSON(…, wide_number_mode=>'round'))",
    },
    // ── statements (the tokens kept here are the SQL text's own, which rides the line beside them) ─
    {
      name: 'unrecognized name',
      codes: [3],
      patterns: [
        new RegExp(`^Unrecognized name: ${SpannerFailureText.IDENTIFIER}(?: \\[at (\\d{1,6}):(\\d{1,6})\\])?`),
      ],
      phrase: (match) =>
        `the statement names something the schema does not have (${SpannerFailureText.identifier(match[1])}${SpannerFailureText.position(match[2], match[3])})`,
    },
    {
      name: 'table not found',
      codes: [3, 5],
      patterns: [new RegExp(`^Table not found: ${SpannerFailureText.IDENTIFIER}(?: \\[at (\\d{1,6}):(\\d{1,6})\\])?`)],
      phrase: (match) =>
        `the statement names a table the schema does not have (${SpannerFailureText.identifier(match[1])}${SpannerFailureText.position(match[2], match[3])})`,
    },
    {
      name: 'value type does not match column',
      codes: [3],
      patterns: [
        new RegExp(`^Value has type \\w{1,32} which cannot be inserted into column ${SpannerFailureText.IDENTIFIER},`),
      ],
      phrase: (match) =>
        `a bound value's type does not match its column (column ${SpannerFailureText.identifier(match[1])})`,
    },
    {
      name: 'no matching signature',
      codes: [3],
      patterns: [/^No matching signature for /],
      phrase: () => 'an operator or function was given argument types it has no signature for',
    },
    {
      name: 'syntax error',
      codes: [3],
      patterns: [/^Syntax error:/, /^Error parsing Spanner DDL statement/],
      phrase: () => 'the statement does not parse (syntax error)',
    },
    // ── schema updates ────────────────────────────────────────────────────────────────────────
    {
      name: 'unique index backfill found duplicates',
      codes: [9],
      patterns: [new RegExp(`^Found uniqueness violation on index ${SpannerFailureText.IDENTIFIER},`, 'i')],
      phrase: (match) =>
        `uniqueness violation: a unique index cannot be built over existing rows that hold duplicate keys (index ${SpannerFailureText.identifier(match[1])})`,
    },
    {
      name: 'index names a missing column',
      codes: [3],
      patterns: [
        new RegExp(
          `^Index ${SpannerFailureText.IDENTIFIER} specifies key column ${SpannerFailureText.IDENTIFIER} which does not exist`
        ),
      ],
      phrase: (match) =>
        `an index names a key column its table does not have (index ${SpannerFailureText.identifier(match[1])}, column ${SpannerFailureText.identifier(match[2])})`,
    },
    {
      name: 'schema change in progress',
      codes: [9],
      patterns: [/concurrent schema change operation or read-write transaction is already in progress/i],
      phrase: () => 'a concurrent schema change operation or read-write transaction is already in progress',
    },
    {
      // The class TableManager's concurrent-create reconcile keys on (isAlreadyExistsError): the
      // duplicate/already-exists phrasings under ALREADY_EXISTS or FAILED_PRECONDITION. The two
      // anchored forms keep the object's name; the loose forms recognize the class and keep nothing.
      name: SpannerFailureText.SCHEMA_OBJECT_ALREADY_EXISTS,
      codes: [6, 9],
      patterns: [
        new RegExp(`^Duplicate column name ${SpannerFailureText.IDENTIFIER}`, 'i'),
        new RegExp(`^Duplicate name in schema: ${SpannerFailureText.IDENTIFIER}`, 'i'),
        /Duplicate column name/i,
        /Duplicate name in schema/i,
        /already exists/i,
      ],
      phrase: (match) =>
        match[1]
          ? `the schema object already exists (${SpannerFailureText.identifier(match[1])})`
          : 'the schema object already exists',
    },
    // ── sessions and streams (sentences the client library's transaction runner reads) ─────────
    {
      name: 'session not found',
      codes: [5],
      patterns: [/Session not found/],
      phrase: () => 'Session not found (the session expired or was deleted; the client library replaces it)',
    },
    {
      name: 'retryable stream reset',
      codes: [13],
      patterns: SpannerFailureText.RETRYABLE_STREAM_RESETS.map(
        (literal) => new RegExp(literal.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
      ),
      phrase: (match) =>
        `the stream was reset mid-call (${SpannerFailureText.RETRYABLE_STREAM_RESETS.find((literal) => literal === match[0])})`,
    },
    {
      name: 'session pool unavailable',
      codes: [undefined],
      patterns: [
        /^No resources available\.?$/,
        /^Timeout occurred while acquiring session\.?$/,
        /^Database is closed\.?$/,
      ],
      phrase: () =>
        'the session pool could not supply a session (exhausted, timed out, or the database handle is closed)',
    },
  ];

  /**
   * `{ code, status, failureClass, message }` of any thrown value — a vendor error, one of the
   * driver's own, a string — as a log line and an error message may carry it. `boundValues` are
   * the failed statement's parameters: what the backend may have echoed into its message.
   */
  static summarize(failure: unknown, boundValues?: BoundValues): OperationCauseSummary {
    const vendor = failure as { code?: unknown; message?: unknown } | null | undefined;
    const code = typeof vendor?.code === 'number' ? vendor.code : undefined;
    const coded = code !== undefined ? { code, status: GRPC_STATUS_NAMES[code] ?? `code ${code}` } : {};
    if (typeof failure === 'object' && failure !== null && SpannerFailureText.HOUSE_AUTHORED.has(failure)) {
      return { ...coded, failureClass: 'driver', message: String(vendor?.message ?? '') };
    }
    const raw = typeof vendor?.message === 'string' ? vendor.message : typeof failure === 'string' ? failure : '';
    const text = SpannerFailureText.strikeBoundValues(raw.replace(/^\d{1,2} [A-Z_]+: /, ''), boundValues);
    for (const failureClass of SpannerFailureText.CLASSES) {
      if (!failureClass.codes.includes(code)) {
        continue;
      }
      for (const pattern of failureClass.patterns) {
        const match = pattern.exec(text);
        if (match) {
          return { ...coded, failureClass: failureClass.name, message: failureClass.phrase(match) };
        }
      }
    }
    return {
      ...coded,
      failureClass: 'unclassified',
      message:
        code !== undefined && SpannerFailureText.CODE_PHRASES[code]
          ? SpannerFailureText.CODE_PHRASES[code]
          : "the failure is not one the driver recognizes; its message is withheld (it can quote row values) — the thrown error's vendorError carries it",
    };
  }

  /** An error whose text the driver wrote itself — kept verbatim wherever a failure is summarized. */
  static houseError(message: string): Error {
    return SpannerFailureText.markHouseAuthored(new Error(message));
  }

  /** Register one of the driver's own typed errors as house-authored (its constructor calls this). */
  static markHouseAuthored<T extends Error>(error: T): T {
    SpannerFailureText.HOUSE_AUTHORED.add(error);
    return error;
  }

  /**
   * The message with every occurrence of every bound value struck out, in each form the backend
   * echoes a value: a string as it is, a number / boolean / bigint in its decimal text, a date in
   * its ISO forms, bytes in base64, a wrapped client value by its `value`, a JSON value as its
   * JSON text and leaf by leaf, an array element by element — and CUT SHORT, which is how the
   * backend prints a long one (`Bad int64 value: rst_5d41402abc4b2a76b9719d9...`).
   */
  private static strikeBoundValues(text: string, boundValues: BoundValues): string {
    if (!boundValues || !text) {
      return text;
    }
    const forms = new Set<string>();
    for (const value of Object.values(boundValues)) {
      SpannerFailureText.collectForms(value, forms, 0);
    }
    let struck = text;
    // Longest first: a value that contains another is struck whole.
    for (const form of Array.from(forms).sort((a, b) => b.length - a.length)) {
      struck = SpannerFailureText.strikeForm(struck, form);
    }
    return struck;
  }

  /**
   * One form struck out of the text. A form is found by its head — its first six characters, or
   * all of it when it is shorter — and struck for as far as the text goes on matching it, so an
   * echo the backend cut short is struck like a whole one. A form shorter than four characters is
   * struck only where it stands as a token of its own: a bound `1` must not strike the `1` inside
   * `size: 103`.
   */
  private static strikeForm(text: string, form: string): string {
    const head = form.slice(0, 6);
    let struck = '';
    let from = 0;
    for (let at = text.indexOf(head, from); at >= 0; at = text.indexOf(head, from)) {
      let end = at + head.length;
      while (end - at < form.length && text[end] === form[end - at]) {
        end++;
      }
      const standsAlone = !/[\w.]/.test(text[at - 1] ?? '') && !/[\w.]/.test(text[end] ?? '');
      if (form.length >= 4 || standsAlone) {
        struck += text.slice(from, at) + SpannerFailureText.STRUCK;
      } else {
        struck += text.slice(from, end);
      }
      from = end;
    }
    return struck + text.slice(from);
  }

  private static collectForms(value: unknown, forms: Set<string>, depth: number): void {
    if (value === null || value === undefined || depth > 6) {
      return;
    }
    const add = (form: unknown) => {
      if (typeof form === 'string' && form.length > 0) {
        forms.add(form);
      }
    };
    if (typeof value === 'string') {
      add(value);
    } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      add(String(value));
    } else if (value instanceof Date) {
      if (!isNaN(value.getTime())) {
        add(value.toISOString());
        add(value.toISOString().slice(0, 10));
      }
    } else if (value instanceof Uint8Array) {
      add(Buffer.from(value).toString('base64'));
      add(Buffer.from(value).toString('utf8'));
    } else if (Array.isArray(value)) {
      value.forEach((element) => SpannerFailureText.collectForms(element, forms, depth + 1));
    } else if (typeof value === 'object') {
      try {
        add(JSON.stringify(value));
      } catch {
        // a value with no JSON text has no such form
      }
      Object.values(value as { [key: string]: unknown }).forEach((leaf) =>
        SpannerFailureText.collectForms(leaf, forms, depth + 1)
      );
    }
  }

  /** A kept identifier, without the sentence-ending dot the backend may print after it. */
  private static identifier(token: string): string {
    return token.replace(/\.+$/, '');
  }

  private static position(line?: string, column?: string): string {
    return line && column ? ` at ${line}:${column}` : '';
  }
}
