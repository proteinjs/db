import { Serializer } from '@proteinjs/serializer';
import {
  SOURCE_RECORDS_BEARER_ENV,
  SOURCE_RECORDS_COOKIE_ENV,
  SOURCE_RECORD_EXPORT_SERVICE_PATH,
  SourceRecordsCli,
  SourceRecordsCliIo,
} from '../src/cli/SourceRecordsCli';
import {
  SourceRecordDeclaration,
  SourceRecordDeclarationBundle,
  SourceRecordDeclarationDocument,
} from '../src/source/SourceRecordDeclaration';

/**
 * `source-records pull`: the export door called as the house service client does, with the
 * consumer's own auth from the environment (never printed); the file written byte-stably with
 * the sibling files of its external columns beside it, and all of them left untouched when
 * nothing changed.
 */
const declaration = (
  rows: { [column: string]: unknown }[],
  exportedAt = '2026-01-01T00:00:00.000Z',
  extra: Partial<SourceRecordDeclaration> = {}
): SourceRecordDeclaration => ({
  format: 'source-records/1',
  table: 'widgets',
  key: 'sku',
  columns: ['sku', 'name'],
  environment: 'fixture-env',
  exportedAt,
  rowCount: rows.length,
  rows,
  ...extra,
});

const bundle = (
  served: SourceRecordDeclaration,
  files: { [path: string]: string } = {}
): SourceRecordDeclarationBundle => ({
  declaration: served,
  files,
});

type Request = { url: string; init: { method: string; headers: { [name: string]: string }; body: string } };

/** A fake server + file system + environment; every seam of the CLI injected. */
const harness = (
  answer: (request: Request) => { status: number; body: unknown },
  env: { [name: string]: string } = {}
) => {
  const requests: Request[] = [];
  const files = new Map<string, string>();
  const writes: string[] = [];
  const lines: string[] = [];
  const io: SourceRecordsCliIo = {
    fetch: async (url, init) => {
      requests.push({ url, init });
      const { status, body } = answer({ url, init });
      return { status, statusText: status === 200 ? 'OK' : 'Nope', text: async () => JSON.stringify(body) };
    },
    readFile: (path) => files.get(path),
    writeFile: (path, text) => {
      files.set(path, text);
      writes.push(path);
    },
    env,
    log: (line) => lines.push(line),
  };
  return { io, requests, files, writes, lines, cli: new SourceRecordsCli(io) };
};

const serving = (served: SourceRecordDeclarationBundle) => () => ({
  status: 200,
  body: { serializedReturn: Serializer.serialize(served) },
});

describe('source-records pull', () => {
  const rows = [
    { sku: 'B', name: 'Bee' },
    { sku: 'A', name: 'Ay' },
  ];

  it("calls the export door as the service client does — POST, the house serializer's args, the consumer's cookie — and writes the file byte-stably", async () => {
    const h = harness(serving(bundle(declaration(rows))), { [SOURCE_RECORDS_COOKIE_ENV]: 'session=abc' });

    const code = await h.cli.run([
      'pull',
      '--from',
      'https://example.test/',
      '--table',
      'widgets',
      '--out',
      '/tmp/widgets.json',
    ]);

    expect(code).toBe(0);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].url).toBe(`https://example.test${SOURCE_RECORD_EXPORT_SERVICE_PATH}`);
    expect(h.requests[0].init.method).toBe('POST');
    expect(h.requests[0].init.headers).toMatchObject({ Cookie: 'session=abc', 'Content-Type': 'application/json' });
    expect(Serializer.deserialize(h.requests[0].init.body)).toEqual(['widgets']);
    expect(h.files.get('/tmp/widgets.json')).toBe(SourceRecordDeclarationDocument.render(declaration(rows)));
    expect(h.lines).toEqual(['widgets: 2 rows from fixture-env → /tmp/widgets.json (written)']);
    // The cookie's value never reaches the output.
    expect(h.lines.join('\n')).not.toContain('abc');
  });

  it('a bearer token is the other door', async () => {
    const h = harness(serving(bundle(declaration(rows))), { [SOURCE_RECORDS_BEARER_ENV]: 'tok-123' });
    expect(await h.cli.run(['pull', '--from', 'http://localhost:9660', '--table', 'widgets', '--out', 'w.json'])).toBe(
      0
    );
    expect(h.requests[0].init.headers.Authorization).toBe('Bearer tok-123');
    expect(h.requests[0].init.headers.Cookie).toBeUndefined();
    expect(h.lines.join('\n')).not.toContain('tok-123');
  });

  it('a re-pull with no change is a no-op: the file (its header time included) is left untouched, and says so', async () => {
    const h = harness(serving(bundle(declaration(rows, '2026-01-01T00:00:00.000Z'))), {
      [SOURCE_RECORDS_COOKIE_ENV]: 'session=fixture-cookie',
    });
    await h.cli.run(['pull', '--from', 'https://example.test', '--table', 'widgets', '--out', 'w.json']);
    const first = h.files.get('w.json');

    // The server exports again, later — same rows, a newer header time.
    const later = harness(serving(bundle(declaration(rows, '2026-06-01T00:00:00.000Z'))), {
      [SOURCE_RECORDS_COOKIE_ENV]: 'session=fixture-cookie',
    });
    later.files.set('w.json', first as string);
    expect(
      await later.cli.run(['pull', '--from', 'https://example.test', '--table', 'widgets', '--out', 'w.json'])
    ).toBe(0);

    expect(later.writes).toEqual([]);
    expect(later.files.get('w.json')).toBe(first);
    expect(later.lines).toEqual(['widgets: 2 rows from fixture-env → w.json (unchanged)']);
  });

  it('a change in the rows rewrites the file with the new header time', async () => {
    const h = harness(serving(bundle(declaration(rows))), { [SOURCE_RECORDS_COOKIE_ENV]: 'session=fixture-cookie' });
    await h.cli.run(['pull', '--from', 'https://example.test', '--table', 'widgets', '--out', 'w.json']);
    const changed = harness(
      serving(bundle(declaration([...rows, { sku: 'C', name: 'Sea' }], '2026-06-01T00:00:00.000Z'))),
      {
        [SOURCE_RECORDS_COOKIE_ENV]: 'session=fixture-cookie',
      }
    );
    changed.files.set('w.json', h.files.get('w.json') as string);
    expect(
      await changed.cli.run(['pull', '--from', 'https://example.test', '--table', 'widgets', '--out', 'w.json'])
    ).toBe(0);
    expect(changed.writes).toEqual(['w.json']);
    expect(changed.files.get('w.json')).toContain('"exportedAt": "2026-06-01T00:00:00.000Z"');
    expect(changed.files.get('w.json')).toContain('"sku": "C"');
  });

  it("an external column's sibling files are written beside the document, byte for byte; an unchanged set is a no-op; a sibling that moved rewrites the set", async () => {
    const withBody = (text: string, exportedAt = '2026-01-01T00:00:00.000Z') =>
      bundle(
        declaration([{ sku: 'A', name: 'Ay', body: 'A/body.md' }], exportedAt, {
          columns: ['sku', 'name', 'body'],
          externalColumns: ['body'],
        }),
        { 'A/body.md': text }
      );
    const h = harness(serving(withBody('# Ay\n\nNo trailing newline here')), {
      [SOURCE_RECORDS_COOKIE_ENV]: 'session=fixture-cookie',
    });
    expect(
      await h.cli.run(['pull', '--from', 'https://example.test', '--table', 'widgets', '--out', 'out/w.json'])
    ).toBe(0);
    expect(h.writes).toEqual(['out/w.json', 'out/A/body.md']);
    expect(h.files.get('out/A/body.md')).toBe('# Ay\n\nNo trailing newline here');
    expect(h.files.get('out/w.json')).toContain('"body": "A/body.md"');
    expect(h.files.get('out/w.json')).not.toContain('No trailing newline');

    // Nothing moved (a newer header time aside): no write at all.
    const same = harness(serving(withBody('# Ay\n\nNo trailing newline here', '2026-06-01T00:00:00.000Z')), {
      [SOURCE_RECORDS_COOKIE_ENV]: 'session=fixture-cookie',
    });
    same.files.set('out/w.json', h.files.get('out/w.json') as string);
    same.files.set('out/A/body.md', h.files.get('out/A/body.md') as string);
    expect(
      await same.cli.run(['pull', '--from', 'https://example.test', '--table', 'widgets', '--out', 'out/w.json'])
    ).toBe(0);
    expect(same.writes).toEqual([]);
    expect(same.lines).toEqual(['widgets: 1 row from fixture-env → out/w.json (unchanged)']);

    // Only the sibling moved: the document (its new header time) and the sibling are written.
    const moved = harness(serving(withBody('# Ay\n\nEdited.\n', '2026-06-01T00:00:00.000Z')), {
      [SOURCE_RECORDS_COOKIE_ENV]: 'session=fixture-cookie',
    });
    moved.files.set('out/w.json', h.files.get('out/w.json') as string);
    moved.files.set('out/A/body.md', h.files.get('out/A/body.md') as string);
    expect(
      await moved.cli.run(['pull', '--from', 'https://example.test', '--table', 'widgets', '--out', 'out/w.json'])
    ).toBe(0);
    expect(moved.writes).toEqual(['out/w.json', 'out/A/body.md']);
    expect(moved.files.get('out/A/body.md')).toBe('# Ay\n\nEdited.\n');
  });

  it('no auth in the environment refuses (exit 2) naming the variables, never a value', async () => {
    const h = harness(serving(bundle(declaration(rows))), {});
    expect(await h.cli.run(['pull', '--from', 'https://example.test', '--table', 'widgets', '--out', 'w.json'])).toBe(
      2
    );
    expect(h.requests).toHaveLength(0);
    expect(h.lines[0]).toContain(SOURCE_RECORDS_COOKIE_ENV);
    expect(h.lines[0]).toContain(SOURCE_RECORDS_BEARER_ENV);
  });

  it("the server's refusal is the exit (1) with its own words; a non-200 too; a reply without a declaration too", async () => {
    const denied = harness(() => ({ status: 200, body: { error: 'Not authorized to run service' } }), {
      [SOURCE_RECORDS_COOKIE_ENV]: 'session=fixture-cookie',
    });
    expect(
      await denied.cli.run(['pull', '--from', 'https://example.test', '--table', 'widgets', '--out', 'w.json'])
    ).toBe(1);
    expect(denied.lines).toEqual(['source-records pull: Not authorized to run service']);
    expect(denied.writes).toEqual([]);

    const down = harness(() => ({ status: 502, body: 'gateway' }), {
      [SOURCE_RECORDS_COOKIE_ENV]: 'session=fixture-cookie',
    });
    expect(
      await down.cli.run(['pull', '--from', 'https://example.test', '--table', 'widgets', '--out', 'w.json'])
    ).toBe(1);
    expect(down.lines[0]).toMatch(/answered 502/);

    const bare = harness(() => ({ status: 200, body: { serializedReturn: Serializer.serialize(declaration(rows)) } }), {
      [SOURCE_RECORDS_COOKIE_ENV]: 'session=fixture-cookie',
    });
    expect(
      await bare.cli.run(['pull', '--from', 'https://example.test', '--table', 'widgets', '--out', 'w.json'])
    ).toBe(1);
    expect(bare.lines[0]).toMatch(/answered without a declaration/);
  });

  it('a transport whose failure echoes the request (headers included) never gets the cookie or the bearer into a printed line — the one output seam redacts them', async () => {
    const secrets: { [name: string]: string }[] = [
      { [SOURCE_RECORDS_COOKIE_ENV]: 'session=SECRET-COOKIE-7f3a' },
      { [SOURCE_RECORDS_BEARER_ENV]: 'SECRET-BEARER-9c1d' },
    ];
    for (const env of secrets) {
      const { cli, lines } = harness(() => ({ status: 200, body: {} }), env);
      cli['io'].fetch = async (url, init) => {
        throw new Error(`fetch failed: ${url} ${JSON.stringify(init)}`);
      };
      expect(await cli.run(['pull', '--from', 'http://localhost:1', '--table', 't', '--out', 'out.json'])).toBe(1);
      const printed = lines.join('\n');
      expect(printed).toContain('fetch failed');
      expect(printed).not.toContain('SECRET-');
    }
  });

  it('bad usage is exit 2 with the usage: a missing flag, a non-url --from, an unknown command', async () => {
    const h = harness(serving(bundle(declaration(rows))), { [SOURCE_RECORDS_COOKIE_ENV]: 'session=fixture-cookie' });
    expect(await h.cli.run(['pull', '--from', 'https://example.test', '--table', 'widgets'])).toBe(2);
    expect(h.lines[0]).toMatch(/--out is required/);
    expect(await h.cli.run(['pull', '--from', 'example.test', '--table', 'widgets', '--out', 'w'])).toBe(2);
    expect(await h.cli.run(['push'])).toBe(2);
    expect(await h.cli.run(['--help'])).toBe(0);
    expect(h.requests).toHaveLength(0);
  });
});
