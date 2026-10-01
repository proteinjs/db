import { Interface, Method, SourceRepository, TypeAliasDeclaration } from '@proteinjs/reflection';
import { READ_CONTACT_TIMEOUT_MS, REDELIVERY_BASE_MS } from '@proteinjs/service';
import { getDbService } from '../src/services/DbService';

/**
 * The db service rides the service client's retry policy by declaration alone: its reads (`query`,
 * `get`, `getRowCount`, `tableExists`) are declared `'read'` on the factory — bounded at the first
 * contact and redelivered as fresh requests under the client's series when a delivery produced no
 * response — and its writes (`insert`, `update`, `updateArrayMembership`, `updatePreserving`,
 * `delete`) stay undeclared: one delivery, no bound, never redelivered. Nothing here is the db
 * package's own logic — the policy, its numbers and its exceptions are @proteinjs/service's; this
 * suite pins the declaration. Read as OUTCOMES off the transport: the requests that left and their
 * watchdog signals, under fake timers.
 *
 * The service interface is seeded into the source repository directly (this package's own test pattern —
 * DbDefaultDriverDuplicateModuleState seeds the object cache the same way), so the real factory
 * builds the real clients without the generated source graph.
 */

type RepositoryInternals = { flattenedSourceGraph: { interfaces: { [qualifiedName: string]: Interface } } };

const READS = ['query', 'get', 'getRowCount', 'tableExists'];
const WRITES = ['insert', 'update', 'updateArrayMembership', 'updatePreserving', 'delete'];

beforeAll(() => {
  // Node's Request rejects the relative service paths a browser resolves against the page origin.
  global.Request = class {
    constructor(
      public url: string,
      public init: any
    ) {}
  } as any;
  const returnType = { name: 'Promise<any>' } as unknown as TypeAliasDeclaration;
  const methods = [...READS, ...WRITES].map(
    (name) => new Method(name, returnType, true, false, false, false, 'public', [])
  );
  (SourceRepository.get() as unknown as RepositoryInternals).flattenedSourceGraph.interfaces[
    '@proteinjs/db/DbService'
  ] = new Interface('@proteinjs/db', 'DbService', [], methods);
});

/** A transport that never answers: its promise settles only when the request is abandoned (its signal aborts). */
const neverAnswers = () =>
  jest.fn(
    (request: any) =>
      new Promise((unused, reject) => {
        request.init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
        );
      })
  );

const sentRequests = (): any[] => (global.fetch as jest.Mock).mock.calls.map(([request]) => request);

/** The call's outcome, readable without awaiting it — a pending call must read as pending. */
const track = (promise: Promise<any>) => {
  const outcome: { state: 'pending' | 'resolved' | 'rejected' } = { state: 'pending' };
  promise.then(
    () => {
      outcome.state = 'resolved';
    },
    () => {
      outcome.state = 'rejected';
    }
  );
  return outcome;
};

const aTable = { name: 'a_table' } as any;

describe('the db service under the client retry policy', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each(READS)(
    '%s is a declared read: bounded at the first contact, redelivered as a fresh request',
    async (name) => {
      global.fetch = neverAnswers() as any;
      const service = getDbService() as any;
      const outcome = track(service[name](aTable, {}));

      await jest.advanceTimersByTimeAsync(READ_CONTACT_TIMEOUT_MS);
      expect(sentRequests()).toHaveLength(1);
      expect(sentRequests()[0].url).toBe(`/service/@proteinjs/db/DbService/${name}`);
      expect(sentRequests()[0].init.signal.aborted).toBe(true);

      await jest.advanceTimersByTimeAsync(REDELIVERY_BASE_MS);
      expect(sentRequests()).toHaveLength(2);
      expect(sentRequests()[1].init.signal.aborted).toBe(false);
      expect(outcome.state).toBe('pending');
    }
  );

  it.each(WRITES)('%s is undeclared: one delivery, no bound, never redelivered', async (name) => {
    global.fetch = neverAnswers() as any;
    const service = getDbService() as any;
    const outcome = track(service[name](aTable, {}));

    await jest.advanceTimersByTimeAsync(READ_CONTACT_TIMEOUT_MS * 4);
    expect(sentRequests()).toHaveLength(1);
    expect(sentRequests()[0].url).toBe(`/service/@proteinjs/db/DbService/${name}`);
    expect(sentRequests()[0].init.signal).toBeUndefined();
    expect(outcome.state).toBe('pending');
  });
});
