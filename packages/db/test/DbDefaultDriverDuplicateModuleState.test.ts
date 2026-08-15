/**
 * Duplicate-module-instance guard for the default db driver (task #36).
 *
 * Per-package installs can put two live copies of @proteinjs/db in one process (each sibling
 * package's nested node_modules hosts its own registry copy). `Db.defaultDbDriver` as a class
 * static then splits per copy: every copy that lazily initializes asks the (globally converged,
 * reflection-routed) DefaultDbDriverFactory for a driver, and the factory mints a fresh one per
 * call — two live Spanner clients holding two gRPC channel sets. That is the 2026-08-14
 * thought-ui incident: jest finished green and then never exited, the second universe's Spanner
 * client keeping the process alive.
 *
 * `jest.isolateModules` reproduces the split semantics exactly: each isolated registry gets its
 * own module instance of Db with its own statics, the same way two nested install paths do. The
 * guard asserts every live copy resolves the SAME driver instance and the factory is consulted
 * once — which only holds when the resolved driver is anchored on the process global, not on a
 * per-copy class static.
 */
import { SourceRepository } from '@proteinjs/reflection';

type DbModule = typeof import('../src/Db');

const loadIsolatedCopy = (): DbModule => {
  let copy: DbModule | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    copy = require('../src/Db');
  });

  if (!copy) {
    throw new Error('Failed to load an isolated copy of Db');
  }

  return copy;
};

describe('Db default driver under duplicate module instances', () => {
  let driversMinted: number;

  beforeEach(() => {
    driversMinted = 0;
    // House test pattern: seed the (globalThis-anchored, therefore converged) SourceRepository
    // object cache directly. The factory mints a fresh driver object per call, mirroring real
    // DefaultDbDriverFactory implementations (e.g. the app's SpannerDriver factory).
    (SourceRepository.get() as any).objectCache['@proteinjs/db/DefaultDbDriverFactory'] = [
      {
        getDbDriver: () => {
          driversMinted++;
          return { minted: driversMinted };
        },
      },
    ];
  });

  afterEach(() => {
    delete (SourceRepository.get() as any).objectCache['@proteinjs/db/DefaultDbDriverFactory'];
    delete (globalThis as any).__proteinjs_db_defaultDbDriver;
  });

  test('every live copy of Db resolves the same default driver instance', () => {
    const copyA = loadIsolatedCopy();
    const copyB = loadIsolatedCopy();
    expect(copyA).not.toBe(copyB); // two distinct module instances, as under per-package installs

    const driverA = copyA.Db.getDefaultDbDriver();
    const driverB = copyB.Db.getDefaultDbDriver();

    expect(driverB).toBe(driverA); // one process, one driver — one live client
    expect(driversMinted).toBe(1); // the factory is consulted exactly once per process
  });
});
