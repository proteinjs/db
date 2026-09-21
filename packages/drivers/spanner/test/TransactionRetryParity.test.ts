import * as fs from 'fs';
import * as path from 'path';
import { isSessionNotFoundError } from '@google-cloud/spanner/build/src/session-pool';
import { isRetryableInternalError, Runner } from '@google-cloud/spanner/build/src/transaction-runner';
import { grpc } from 'google-gax';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';

/**
 * THE RETRY LAW, scenario by scenario: the error a transaction body throws leads the client
 * library's transaction runner to EXACTLY the retries the release line leads it to — never fewer,
 * never more. What the driver PRINTS about a failure is the driver's to change (the backend's
 * message rides no log line — SpannerFailureLine); what it THROWS is not, and this suite is the
 * gate that a change to the first never moves the second.
 *
 * The runner decides on the thrown error alone (read in @google-cloud/spanner 7.5.0): its run loop
 * re-runs on `code === ABORTED` or `isRetryableInternalError` (INTERNAL + one of four literals in
 * the MESSAGE) and backs off by the `google.rpc.retryinfo-bin` metadata entry;
 * `Database.runTransactionAsync` re-runs on a fresh session, in a loop nothing bounds, on
 * `isSessionNotFoundError` (NOT_FOUND + `Session not found` in the MESSAGE), and the pool drops a
 * session whose last error reads that way. So the library's whole behaviour is a function of what
 * those reads return — the VERDICT recorded here per scenario.
 *
 * Every scenario goes through the driver's REAL failure path at one of the five doors a
 * transaction body's error comes through (a statement on a caller's transaction: `runDml`,
 * `runQuery`; the driver's own single-statement transaction; the commit; a schema update issued
 * inside a body), with the vendor client's rejection stubbed in place of the RPC. EXPECTED is not
 * computed by this file: it is the verdict RECORDED from the release line
 * (TransactionRetryParity.recorded.json — this same file, run once with
 * `RETRY_PARITY_RECORD=<path> RETRY_PARITY_RECORDED_FROM=<release sha>` on a checkout of it).
 *
 * The matrix: every retry signal x bound values that overlap its literal, and the backend ECHOING
 * a bound literal in each form it prints a value — quoted, braced, bracketed (masked in the typed
 * error's message: a final failure at a statement's door), bare (`Could not parse <value> as a
 * TIMESTAMP`, `Bad int64 value: <value>`), parenthesized, split by whitespace, past the bounded
 * line — each with and without a retry delay from the backend, and each again under the codes
 * the backend really refuses a value with (which no runner retries, whatever the value spells).
 */

type Door =
  'dml on a transaction' | 'query on a transaction' | 'single-statement dml' | 'commit' | 'schema update in a body';
type Bound = { [param: string]: unknown };
type Scenario = {
  id: string;
  door: Door;
  code: number;
  message: unknown;
  bound: Bound;
  table: string;
  retryInfo: boolean;
};
type Recorded = { recordedFrom: string; clientLibrary: string; verdicts: { [scenarioId: string]: string } };

const DOORS: Door[] = [
  'dml on a transaction',
  'query on a transaction',
  'single-statement dml',
  'commit',
  'schema update in a body',
];
/** The doors whose failure leaves as the vendor's own error, never wrapped: the runner reads the backend's message as it arrived. */
const UNWRAPPED_DOORS: Door[] = ['commit', 'schema update in a body'];
const RECORDED_FILE = path.join(__dirname, 'TransactionRetryParity.recorded.json');
const RECORD_TO = process.env.RETRY_PARITY_RECORD;

const SESSION = 'Session not found';
const RESETS = [
  'Received unexpected EOS on DATA frame from server',
  'RST_STREAM',
  'HTTP/2 error code: INTERNAL_ERROR',
  'Connection closed with unknown cause',
];

/** The signals as the backend really words them. */
const SIGNALS: { name: string; code: number; message: string; literal?: string }[] = [
  {
    name: 'abort',
    code: 10,
    message:
      '10 ABORTED: Transaction was aborted. It was wounded by a higher priority transaction due to conflict on keys in range [[on], [closed]), column note in table ledger.',
  },
  {
    name: 'lost session',
    code: 5,
    message: '5 NOT_FOUND: Session not found: projects/p/instances/i/databases/d/sessions/s-2',
    literal: SESSION,
  },
  {
    name: 'reset (EOS)',
    code: 13,
    message: '13 INTERNAL: Received unexpected EOS on DATA frame from server',
    literal: RESETS[0],
  },
  {
    name: 'reset (RST_STREAM)',
    code: 13,
    message: '13 INTERNAL: Received RST_STREAM with code 2 (Internal server error)',
    literal: RESETS[1],
  },
  { name: 'reset (HTTP/2)', code: 13, message: '13 INTERNAL: HTTP/2 error code: INTERNAL_ERROR', literal: RESETS[2] },
  {
    name: 'reset (closed)',
    code: 13,
    message: '13 INTERNAL: Connection closed with unknown cause',
    literal: RESETS[3],
  },
];

/** Failures no runner retries — whatever is bound. */
const FINAL: { name: string; code: number; message: string }[] = [
  { name: 'internal, no literal', code: 13, message: '13 INTERNAL: the backend gave up' },
  { name: 'table not found', code: 5, message: '5 NOT_FOUND: Table not found: ledger' },
  { name: 'precondition', code: 9, message: '9 FAILED_PRECONDITION: a precondition failed' },
  { name: 'unavailable', code: 14, message: '14 UNAVAILABLE: Connection dropped' },
  { name: 'the literal under another code', code: 9, message: `9 FAILED_PRECONDITION: ${SESSION}: sessions/s-2` },
  { name: 'a reset literal under another code', code: 14, message: '14 UNAVAILABLE: Received RST_STREAM' },
];

/** Each form the backend prints an echoed value in (or could) — `v` is the bound value. */
const ECHO_FORMS: { name: string; echo: (v: string) => string }[] = [
  {
    name: 'braced+quoted key',
    echo: (v) =>
      `Insert failed because key was not found in parent table:  Parent Table: p  Child Table: c  Key: {String("${v}")}`,
  },
  { name: 'bracketed key', echo: (v) => `Row [${v}] in table t is missing. Row cannot be updated.` },
  { name: 'bracketed among keys', echo: (v) => `Rows [a, ${v}, b] in table t are missing.` },
  { name: 'double-quoted', echo: (v) => `Unexpected value "${v}"` },
  { name: 'double-quoted, an escaped quote before it', echo: (v) => `Unexpected value "a \\" ${v}"` },
  { name: 'single-quoted', echo: (v) => `Unexpected value '${v}'` },
  { name: 'braced', echo: (v) => `Unexpected key {${v}}` },
  { name: 'nested braces', echo: (v) => `Unexpected key {{${v}}}` },
  { name: 'bare', echo: (v) => `Row ${v} in table t is missing.` },
  { name: 'bare, an unparsable timestamp', echo: (v) => `Could not parse ${v} as a TIMESTAMP.` },
  { name: 'bare, an unparsable integer', echo: (v) => `Bad int64 value: ${v}` },
  { name: 'a duplicate key of a backfill', echo: (v) => `uniqueness violation: duplicate key: {String("${v}")}` },
  { name: 'bare, first', echo: (v) => `${v} is missing.` },
  { name: 'parenthesized', echo: (v) => `Unexpected value (${v})` },
  { name: 'backticked', echo: (v) => `Unexpected value \`${v}\`` },
  { name: 'an unclosed double quote', echo: (v) => `Unexpected value "${v}` },
  { name: 'an unclosed bracket', echo: (v) => `Unexpected value [${v}` },
  { name: 'braces broken by a newline', echo: (v) => `Unexpected key {\n${v}}` },
  { name: 'brackets broken by a newline', echo: (v) => `Unexpected key [\n${v}]` },
  { name: 'braces longer than the mask reaches', echo: (v) => `Unexpected key {${'k'.repeat(301)}${v}}` },
  { name: 'past the bounded line', echo: (v) => `${'no such row; '.repeat(30)}${v}` },
  { name: 'straddling the end of the bounded line', echo: (v) => `${'x'.repeat(282)} ${v}` },
  {
    name: 'ending exactly at the bounded line',
    echo: (v) => `${'x'.repeat(300 - '5 NOT_FOUND: '.length - v.length - 1)} ${v}`,
  },
  { name: 'quoted, and bare after it', echo: (v) => `Unexpected value "${v}"; ${v}` },
  { name: 'beside a long number', echo: (v) => `Unexpected value 1234567 ${v} 7654321` },
];

const retryInAMillisecond = (): grpc.Metadata => {
  const trailers = new grpc.Metadata();
  trailers.set('google.rpc.retryinfo-bin', Buffer.from([10, 4, 16, 192, 132, 61])); // RetryInfo { retry_delay: 1_000_000ns }
  trailers.set('grpc-status-details-bin', Buffer.from('status details'));
  return trailers;
};

const STATUS_NAMES: { [code: number]: string } = {
  3: 'INVALID_ARGUMENT',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  9: 'FAILED_PRECONDITION',
  11: 'OUT_OF_RANGE',
  13: 'INTERNAL',
};
const statusName = (code: number) => STATUS_NAMES[code] ?? `CODE_${code}`;
/** The codes the backend refuses a bound value with. */
const ECHO_CODES = [3, 6, 9, 11];

/** Bound values that overlap a signal's literal — each alone, then together. */
const boundSetsFor = (signal: { message: string; literal?: string }): { label: string; bound: Bound }[] => [
  { label: 'nothing overlapping', bound: { n: 7, note: 'a note' } },
  { label: 'n=2', bound: { n: 2, note: 'a note' } },
  ...['on', 'closed', 'found', 'Session', 'error', 'server', 'unknown', 'INTERNAL_ERROR', 'not', 'aborted'].map(
    (note) => ({ label: `note=${note}`, bound: { n: 7, note } })
  ),
  ...(signal.literal ? [{ label: 'note=<the literal>', bound: { n: 7, note: signal.literal } }] : []),
  { label: 'note=<the whole message>', bound: { n: 7, note: signal.message } },
  { label: 'note=<the message sans status>', bound: { n: 7, note: signal.message.replace(/^\d+ [A-Z_]+: /, '') } },
  {
    label: 'everything at once',
    bound: { n: 2, note: 'on closed found', tags: ['on', 'closed', 'found', '2', SESSION, ...RESETS] },
  },
];

const scenarios = (): Scenario[] => {
  const all: Scenario[] = [];
  const add = (door: Door, name: string, scenario: Omit<Scenario, 'id' | 'door' | 'table'> & { table?: string }) =>
    all.push({ table: 'ledger', ...scenario, door, id: `${door} | ${name}` });
  for (const door of DOORS) {
    for (const signal of SIGNALS) {
      for (const { label, bound } of boundSetsFor(signal)) {
        add(door, `${signal.name} | ${label}`, { code: signal.code, message: signal.message, bound, retryInfo: true });
      }
      add(door, `${signal.name} | no retry delay from the backend`, {
        code: signal.code,
        message: signal.message,
        bound: { n: 2, note: 'on' },
        retryInfo: false,
      });
    }
    for (const final of FINAL) {
      for (const literal of [SESSION, ...RESETS]) {
        add(door, `final: ${final.name} | note=${literal}`, {
          code: final.code,
          message: final.message,
          bound: { n: 2, note: literal, tags: [literal] },
          retryInfo: false,
        });
      }
    }
    for (const literal of [SESSION, ...RESETS]) {
      const code = literal === SESSION ? 5 : 13;
      for (const form of ECHO_FORMS) {
        add(door, `echo: ${form.name} | ${literal}`, {
          code,
          message: `${code} ${statusName(code)}: ${form.echo(literal)}`,
          bound: { n: 7, note: literal },
          retryInfo: true,
        });
        add(door, `echo: ${form.name} | ${literal} | no retry delay from the backend`, {
          code,
          message: `${code} ${statusName(code)}: ${form.echo(literal)}`,
          bound: { n: 7, note: literal },
          retryInfo: false,
        });
      }
      // The literal with its whitespace doubled, tabbed and broken — the bounded line collapses it.
      for (const [name, gap] of [
        ['two spaces', '  '],
        ['a tab', '\t'],
        ['a line break', '\n'],
      ]) {
        add(door, `echo: bare, its spaces as ${name} | ${literal}`, {
          code,
          message: `${code} ${statusName(code)}: ${literal.replace(/ /g, gap)}: more`,
          bound: { n: 7, note: literal.replace(/ /g, gap) },
          retryInfo: true,
        });
      }
    }
    // The echoes as they really arrive: under the codes the backend refuses a value with
    // (INVALID_ARGUMENT, ALREADY_EXISTS, FAILED_PRECONDITION, OUT_OF_RANGE) — none of which any
    // runner retries, whatever literal the echoed value spells.
    for (const code of ECHO_CODES) {
      for (const literal of [SESSION, ...RESETS]) {
        for (const form of ECHO_FORMS) {
          add(door, `echo under code ${code}: ${form.name} | ${literal}`, {
            code,
            message: `${code} ${statusName(code)}: ${form.echo(literal)}`,
            bound: { n: 7, note: literal },
            retryInfo: false,
          });
        }
      }
    }
    // A table NAMED like a literal puts it in the statement's shape, which the message carries.
    add(door, 'a table named RST_STREAM | internal, no literal', {
      code: 13,
      message: '13 INTERNAL: the backend gave up',
      bound: { n: 7, note: 'a note' },
      table: 'RST_STREAM',
      retryInfo: false,
    });
  }
  // A rejection whose message is not a string (never the vendor client's; the statement doors only —
  // the client library itself cannot read such an error where it arrives unwrapped).
  for (const door of DOORS.filter((each) => !UNWRAPPED_DOORS.includes(each))) {
    for (const code of [5, 13]) {
      add(door, `a message that is not a string | code ${code}`, {
        code,
        message: undefined,
        bound: { n: 7, note: SESSION },
        retryInfo: false,
      });
    }
  }
  return all;
};

describe('the retry law: the runner`s verdict on the thrown error, scenario by scenario, against the recorded release line', () => {
  type DriverStatics = { SPANNER_DB?: unknown; LIVENESS_MONITOR?: unknown };
  const statics = SpannerDriver as unknown as DriverStatics;
  const fakeMonitor = {
    logPoolPressure: () => undefined,
    poolStats: () => ({ size: 0, available: 0, borrowed: 0, pending: 0, totalWaiters: 0 }),
    reportError: () => undefined,
    stop: () => undefined,
  };
  let driver: SpannerDriver;

  beforeEach(() => {
    statics.LIVENESS_MONITOR = fakeMonitor;
    driver = new SpannerDriver({ projectId: 'fake', instanceName: 'fake', databaseName: 'fake' });
    const logger = (driver as unknown as { logger: { [level: string]: () => void } }).logger;
    for (const level of ['error', 'warn', 'info', 'debug']) {
      jest.spyOn(logger, level).mockImplementation(() => {});
    }
  });

  afterEach(() => {
    statics.SPANNER_DB = undefined;
    statics.LIVENESS_MONITOR = undefined;
    jest.restoreAllMocks();
  });

  /** What the transaction body THROWS when `rejection` stands in for the RPC at `door` — the error the runner reads. */
  const thrownAt = async (scenario: Scenario, rejection: unknown): Promise<unknown> => {
    const dml = () => ({
      sql: `INSERT INTO \`${scenario.table}\` (\`n\`, \`note\`) VALUES (@n, @note)`,
      namedParams: { params: scenario.bound, types: {} },
    });
    const query = () => ({
      sql: `SELECT \`n\` FROM \`${scenario.table}\` WHERE \`note\` = @note`,
      namedParams: { params: scenario.bound, types: {} },
    });
    const atCommit = scenario.door === 'commit';
    const transaction = {
      batchUpdate: () => (atCommit ? Promise.resolve([[1]]) : Promise.reject(rejection)),
      run: () => Promise.reject(rejection),
      commit: () => (atCommit ? Promise.reject(rejection) : Promise.resolve()),
      rollback: () => Promise.resolve(),
    };
    let bodyThrew: unknown = 'the body did not throw';
    // The driver's own transactions ride the client library's runner: here it runs the body ONCE
    // and keeps what the body threw — the error the real runner would decide on.
    statics.SPANNER_DB = {
      updateSchema: () => Promise.reject(rejection),
      runTransactionAsync: async (_options: unknown, body: (handle: unknown) => Promise<unknown>) => {
        try {
          return await body(transaction);
        } catch (error) {
          bodyThrew = error;
          throw error;
        }
      },
    };
    const settle = (work: Promise<unknown>) =>
      work.then(
        () => 'the door did not reject',
        (error: unknown) => error
      );
    switch (scenario.door) {
      case 'dml on a transaction':
        return await settle(driver.runDml(dml, transaction as any));
      case 'query on a transaction':
        return await settle(driver.runQuery(query, transaction as any));
      case 'single-statement dml':
        await settle(driver.runDml(dml));
        return bodyThrew;
      case 'commit':
        await settle(driver.runTransaction((handle) => driver.runDml(dml, handle)));
        return bodyThrew;
      case 'schema update in a body':
        await settle(
          driver.runTransaction(() =>
            driver.runUpdateSchema(`CREATE INDEX ${scenario.table}_note ON ${scenario.table}(note)`)
          )
        );
        return bodyThrew;
    }
  };

  /** Everything the client library reads off a thrown error to decide what happens next. */
  const verdictOf = (thrown: unknown, scenario: Scenario): string => {
    const error = thrown as { code?: number; message: string };
    const runnerReruns = error.code === 10 || isRetryableInternalError(error as any);
    const lostSession = isSessionNotFoundError(error as any);
    const delay =
      runnerReruns && scenario.retryInfo
        ? ` after ${(Runner.prototype as unknown as { getNextDelay(error: unknown): number }).getNextDelay.call({ attempts: 1 }, error)}ms`
        : '';
    return runnerReruns ? `the runner re-runs it${delay}` : lostSession ? 're-run on a fresh session' : 'final';
  };

  const verdicts = async (): Promise<{ [scenarioId: string]: string }> => {
    const recorded: { [scenarioId: string]: string } = {};
    for (const scenario of scenarios()) {
      const rejection = Object.assign(
        new Error(),
        { message: scenario.message, code: scenario.code, details: scenario.message },
        scenario.retryInfo ? { metadata: retryInAMillisecond() } : {}
      );
      const thrown = await thrownAt(scenario, rejection);
      expect(typeof (thrown as { code?: unknown })?.code).toBe('number');
      recorded[scenario.id] = verdictOf(thrown, scenario);
    }
    return recorded;
  };

  test('every scenario has an id of its own, and every door and direction is in the matrix', () => {
    const ids = scenarios().map((scenario) => scenario.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(4024);
  });

  if (RECORD_TO) {
    test('RECORD: write this checkout`s verdicts (run on the release line only)', async () => {
      const recorded: Recorded = {
        recordedFrom: process.env.RETRY_PARITY_RECORDED_FROM ?? 'unknown',
        clientLibrary: require('@google-cloud/spanner/package.json').version,
        verdicts: await verdicts(),
      };
      fs.writeFileSync(RECORD_TO, `${JSON.stringify(recorded, null, 1)}\n`);
    });
    return;
  }

  test('the verdict on every thrown error is the recorded one — never fewer retries, never more', async () => {
    const recorded: Recorded = JSON.parse(fs.readFileSync(RECORDED_FILE, 'utf8'));
    const now = await verdicts();
    const differing = Object.keys({ ...recorded.verdicts, ...now })
      .filter((id) => recorded.verdicts[id] !== now[id])
      .map((id) => ({ scenario: id, recorded: recorded.verdicts[id] ?? '(not recorded)', now: now[id] ?? '(gone)' }));

    expect(recorded.clientLibrary).toBe(require('@google-cloud/spanner/package.json').version);
    expect(differing).toEqual([]);
  });

  test('the recording holds BOTH directions (it is not all one verdict), at every door', () => {
    const recorded: Recorded = JSON.parse(fs.readFileSync(RECORDED_FILE, 'utf8'));
    for (const door of DOORS) {
      const at = (name: string) => recorded.verdicts[`${door} | ${name}`];

      expect(at('lost session | note=found')).toBe('re-run on a fresh session');
      expect(at('reset (HTTP/2) | n=2')).toBe('the runner re-runs it after 1ms');
      expect(at('abort | nothing overlapping')).toBe('the runner re-runs it after 1ms');
      expect(at(`echo: bare | ${SESSION}`)).toBe('re-run on a fresh session');
      expect(at(`final: table not found | note=${SESSION}`)).toBe('final');
      // A quoted/braced/bracketed echo is final at a statement's door, where the runner is shown
      // the typed error's masked message; a failed commit or schema update reaches it unmasked.
      expect(at(`echo: braced+quoted key | ${SESSION}`)).toBe(
        UNWRAPPED_DOORS.includes(door) ? 're-run on a fresh session' : 'final'
      );
      expect(at('echo: double-quoted | RST_STREAM')).toBe(
        UNWRAPPED_DOORS.includes(door) ? 'the runner re-runs it after 1ms' : 'final'
      );
    }
  });
});
