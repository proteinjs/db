import { Serializer } from '@proteinjs/serializer';
import { SourceRecordDeclaration, SourceRecordDeclarationDocument } from '../source/SourceRecordDeclaration';

/** The environment variables the pull command reads its auth from — never their values. */
export const SOURCE_RECORDS_COOKIE_ENV = 'SOURCE_RECORDS_COOKIE';
export const SOURCE_RECORDS_BEARER_ENV = 'SOURCE_RECORDS_BEARER';

/** The export door's service path on the consumer's server (see SourceRecordExportService). */
export const SOURCE_RECORD_EXPORT_SERVICE_PATH = '/service/@proteinjs/db/SourceRecordExportService/export';

export type SourceRecordsCliIo = {
  /** The request seam (`globalThis.fetch` in the bin) — injectable for the suites. */
  fetch: (
    url: string,
    init: { method: string; headers: { [name: string]: string }; body: string }
  ) => Promise<{
    status: number;
    statusText: string;
    text: () => Promise<string>;
  }>;
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, text: string) => void;
  env: { [name: string]: string | undefined };
  log: (line: string) => void;
};

export type PullOutcome = { declaration: SourceRecordDeclaration; wrote: boolean; path: string };

/**
 * `source-records pull --from <base url> --table <name> --out <file>` — the pull command: calls
 * the consumer's export door as the house service client does (POST, the house serializer's
 * JSON, the reply's `serializedReturn` or `error`) with the consumer's OWN auth — a session
 * cookie (`SOURCE_RECORDS_COOKIE`, the whole `Cookie` header value) or a bearer token
 * (`SOURCE_RECORDS_BEARER`); the library adds no auth of its own and never prints either — and
 * writes the declaration file byte-stably. When the rows are unchanged the file is left exactly
 * as it is (its header time included): a re-pull with no change is a no-op diff.
 */
export class SourceRecordsCli {
  constructor(private io: SourceRecordsCliIo) {}

  /** The bin's entry: exit 0 done · 1 the pull failed · 2 bad usage. */
  async run(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;
    if (command !== 'pull') {
      this.say(SourceRecordsCli.usage());
      return command === 'help' || command === '--help' || command === undefined ? 0 : 2;
    }
    let flags: { from: string; table: string; out: string };
    try {
      flags = SourceRecordsCli.parsePullFlags(rest);
    } catch (error) {
      this.say(`source-records pull: ${(error as Error).message}\n\n${SourceRecordsCli.usage()}`);
      return 2;
    }
    const auth = this.authHeaders();
    if (!auth) {
      this.say(
        `source-records pull: no auth — set ${SOURCE_RECORDS_COOKIE_ENV} (the session cookie header for ${flags.from}) ` +
          `or ${SOURCE_RECORDS_BEARER_ENV} (a bearer token) in the environment`
      );
      return 2;
    }
    try {
      const outcome = await this.pull(flags.from, flags.table, flags.out, auth);
      const { declaration, wrote, path } = outcome;
      this.say(
        `${declaration.table}: ${declaration.rowCount} ${declaration.rowCount == 1 ? 'row' : 'rows'} from ` +
          `${declaration.environment} → ${path} (${wrote ? 'written' : 'unchanged'})`
      );
      return 0;
    } catch (error) {
      this.say(`source-records pull: ${(error as Error).message}`);
      return 1;
    }
  }

  /** The pull itself: the export door's declaration, written only when its rows changed. */
  async pull(from: string, table: string, out: string, auth: { [name: string]: string }): Promise<PullOutcome> {
    const declaration = await this.exportFrom(from, table, auth);
    const existing = this.io.readFile(out);
    if (existing !== undefined) {
      let current: SourceRecordDeclaration | undefined;
      try {
        current = SourceRecordDeclarationDocument.parse(existing, out);
      } catch (error) {
        current = undefined; // an unreadable file is replaced
      }
      if (current && SourceRecordDeclarationDocument.sameRows(current, declaration)) {
        return { declaration: current, wrote: false, path: out };
      }
    }
    this.io.writeFile(out, SourceRecordDeclarationDocument.render(declaration));
    return { declaration, wrote: true, path: out };
  }

  static usage(): string {
    return [
      'source-records pull --from <base url> --table <table name> --out <file>',
      '',
      "  Calls the server's export door (the SourceRecordExportService of @proteinjs/db, behind the",
      "  consumer's grant) with your own session and writes the table's declaration file, byte-stably;",
      '  an unchanged declaration leaves the file untouched.',
      '',
      `  Auth, from the environment (never printed): ${SOURCE_RECORDS_COOKIE_ENV}=<the Cookie header value of a`,
      `  signed-in session> or ${SOURCE_RECORDS_BEARER_ENV}=<a bearer token>.`,
    ].join('\n');
  }

  private async exportFrom(
    from: string,
    table: string,
    auth: { [name: string]: string }
  ): Promise<SourceRecordDeclaration> {
    const url = from.replace(/\/+$/, '') + SOURCE_RECORD_EXPORT_SERVICE_PATH;
    const response = await this.io.fetch(url, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: Serializer.serialize([table]),
    });
    const text = await response.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch (error) {
      body = undefined;
    }
    if (response.status !== 200) {
      throw new Error(
        typeof body?.error === 'string' && body.error
          ? body.error
          : `${url} answered ${response.status} ${response.statusText}`
      );
    }
    if (body?.error) {
      throw new Error(String(body.error));
    }
    if (typeof body?.serializedReturn !== 'string') {
      throw new Error(`${url} answered without a serialized return`);
    }
    const declaration = Serializer.deserialize(body.serializedReturn);
    // The reply is validated like a file: the same document, the same rules.
    return SourceRecordDeclarationDocument.parse(JSON.stringify(declaration), `the export from ${from}`);
  }

  /**
   * The one output seam: every line the command prints passes here, and the auth values the
   * environment holds are redacted from it — a transport or a server that echoes the request
   * (headers included) into an error still never gets a cookie or a bearer onto the terminal.
   */
  private say(line: string): void {
    let redacted = line;
    for (const name of [SOURCE_RECORDS_COOKIE_ENV, SOURCE_RECORDS_BEARER_ENV]) {
      const value = this.io.env[name];
      if (value) {
        redacted = redacted.split(value).join(`<${name}>`);
      }
    }
    this.io.log(redacted);
  }

  private authHeaders(): { [name: string]: string } | undefined {
    const cookie = this.io.env[SOURCE_RECORDS_COOKIE_ENV];
    if (cookie) {
      return { Cookie: cookie };
    }
    const bearer = this.io.env[SOURCE_RECORDS_BEARER_ENV];
    if (bearer) {
      return { Authorization: `Bearer ${bearer}` };
    }
    return undefined;
  }

  private static parsePullFlags(args: string[]): { from: string; table: string; out: string } {
    const flags: { [name: string]: string } = {};
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!arg.startsWith('--')) {
        throw new Error(`unexpected argument ${arg}`);
      }
      const name = arg.slice(2);
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--${name} needs a value`);
      }
      flags[name] = value;
      i++;
    }
    for (const required of ['from', 'table', 'out']) {
      if (!flags[required]) {
        throw new Error(`--${required} is required`);
      }
    }
    for (const name of Object.keys(flags)) {
      if (!['from', 'table', 'out'].includes(name)) {
        throw new Error(`unknown flag --${name}`);
      }
    }
    if (!/^https?:\/\//.test(flags.from)) {
      throw new Error(`--from must be a base url (http:// or https://), got ${flags.from}`);
    }

    return { from: flags.from, table: flags.table, out: flags.out };
  }
}
