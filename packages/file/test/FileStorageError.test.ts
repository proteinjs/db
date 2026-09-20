import util from 'util';
import { FileStorageError } from '../src/FileStorageError';

/** An obviously fake credential — what a store client's error carries in its request headers. */
const MARKER = 'FAKE-TOKEN-MARKER';

/**
 * What a driver's error carries is the driver's to own: a code, a plain message, the HTTP status.
 * Whatever a caller does with one — print it, serialise it, inspect it — reads those three facts.
 */
describe('FileStorageError', () => {
  it('carries the code, a plain message and the status — and nothing else', () => {
    const error = new FileStorageError('not-found', 'getFileData failed for file file-1', {
      status: 404,
      detail: 'No such object: a-bucket/file-1',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toEqual('not-found');
    expect(error.status).toEqual(404);
    expect(error.message).toEqual(
      'getFileData failed for file file-1: not-found (HTTP 404) — No such object: a-bucket/file-1'
    );
    expect(Object.keys(error).sort()).toEqual(['code', 'name', 'status']);
    expect(Object.getOwnPropertyNames(error).sort()).toEqual(['code', 'message', 'name', 'stack', 'status']);
  });

  it('never reads an object into its message — only text is kept as the store’s detail', () => {
    const vendorError = { message: 'boom', config: { headers: { Authorization: `Bearer ${MARKER}` } } };

    const error = new FileStorageError('unknown', 'createFile failed for file file-2', { detail: vendorError });

    expect(error.message).toEqual('createFile failed for file file-2: unknown');
    expect(util.inspect(error, { depth: null, showHidden: true })).not.toContain(MARKER);
  });

  it('keeps a store’s text plain: one line, bounded, no URL query string, no bearer credential', () => {
    const detail =
      `Request to https://storage.example/b/a-bucket/o/file-3?X-Goog-Signature=${MARKER}&X-Goog-Expires=900 failed\n` +
      `with headers Authorization: Bearer ${MARKER} ` +
      'x'.repeat(1000);

    const error = new FileStorageError('unavailable', 'getSignedUrl failed for file file-3', { status: 503, detail });

    expect(error.message).not.toContain(MARKER);
    expect(error.message).not.toContain('\n');
    expect(error.message).toContain('https://storage.example/b/a-bucket/o/file-3 failed');
    expect(error.message).toContain('Bearer [masked]');
    expect(error.message.length).toBeLessThan(400);
  });

  it('is recognised by its shape, so a copy from a duplicate package still reads as not-found', () => {
    const fromAnotherCopy = Object.assign(new Error('getFileData failed'), {
      name: 'FileStorageError',
      code: 'not-found',
    });

    expect(FileStorageError.is(fromAnotherCopy)).toBe(true);
    expect(FileStorageError.isNotFound(fromAnotherCopy)).toBe(true);
    expect(FileStorageError.isNotFound(new FileStorageError('forbidden', 'getFileData failed'))).toBe(false);
    expect(FileStorageError.is(Object.assign(new Error('a vendor error'), { code: 404 }))).toBe(false);
    expect(FileStorageError.is(Object.assign(new Error('x'), { name: 'FileStorageError', code: 'made-up' }))).toBe(
      false
    );
    expect(FileStorageError.is(undefined)).toBe(false);
  });

  it('reads one HTTP status one way', () => {
    expect(FileStorageError.codeForStatus(404)).toEqual('not-found');
    expect(FileStorageError.codeForStatus(412)).toEqual('precondition-failed');
    expect(FileStorageError.codeForStatus(401)).toEqual('forbidden');
    expect(FileStorageError.codeForStatus(403)).toEqual('forbidden');
    expect(FileStorageError.codeForStatus(408)).toEqual('unavailable');
    expect(FileStorageError.codeForStatus(429)).toEqual('unavailable');
    expect(FileStorageError.codeForStatus(503)).toEqual('unavailable');
    expect(FileStorageError.codeForStatus(400)).toEqual('unknown');
    expect(FileStorageError.codeForStatus(undefined)).toEqual('unknown');
  });
});
