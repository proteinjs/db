import {
  SpannerDriver,
  SpannerEnvTokenAuth,
  SpannerEnvTokenAuthError,
  SPANNER_ENV_TOKEN_VAR,
} from '@proteinjs/db-driver-spanner';
import { printed } from './util/printedLine';

/**
 * Env-delivered token auth (CLOUDSDK_AUTH_ACCESS_TOKEN — the sandbox dev-server leg,
 * plans/CLOUD_CREDENTIALS.md / DEV_INFRA_PLAN.md §12.5): with the env var present the driver
 * builds its Spanner client on that bearer token; absent, construction is the ADC path exactly
 * as before; with SPANNER_EMULATOR_HOST set the vendor short-circuits auth entirely.
 *
 * The emulator cannot verify real auth, so these tests pin the CLIENT-CONSTRUCTION contract
 * (which credential the built client carries, and what its RPC headers say) plus the
 * expiry/rotation and loud-failure contracts. Pure unit tests: no emulator, no RPCs — client
 * construction only, and fake Database/monitor statics for the op-failure translation
 * (the SpannerOperationDeadline.test.ts pattern).
 */

type DriverStatics = {
  SPANNER?: unknown;
  SPANNER_INSTANCE?: unknown;
  SPANNER_DB?: unknown;
  LIVENESS_MONITOR?: unknown;
  ENV_TOKEN_AUTH?: SpannerEnvTokenAuth;
};

const statics = SpannerDriver as unknown as DriverStatics;

type DriverInternals = {
  getSpanner: () => { auth: { cachedCredential: unknown }; options: Record<string, unknown> };
};

const fakeMonitor = {
  logPoolPressure: () => undefined,
  poolStats: () => ({ size: 0, available: 0, borrowed: 0, pending: 0, totalWaiters: 0 }),
  reportError: () => undefined,
  stop: () => undefined,
};

const generateStatement = (() => ({ sql: 'SELECT 1', namedParams: { params: {} } })) as any;

const unauthenticated = () =>
  Object.assign(new Error('UNAUTHENTICATED: invalid authentication credentials'), { code: 16 });

const bearerOf = async (client: unknown): Promise<string | undefined> => {
  const headers = await (client as { getRequestHeaders: () => Promise<Record<string, string>> }).getRequestHeaders();
  return headers.Authorization;
};

const internals = (driver: SpannerDriver) => driver as unknown as DriverInternals;

const makeDriver = (config?: Partial<ConstructorParameters<typeof SpannerDriver>[0]>) => {
  const driver = new SpannerDriver({
    projectId: 'fake',
    instanceName: 'fake',
    databaseName: 'fake',
    ...config,
  });
  // auth-failure logs are expected output of these tests — keep the run quiet
  jest.spyOn((driver as any).logger, 'error').mockImplementation(() => undefined);
  return driver;
};

describe('Spanner env-token auth', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv[SPANNER_ENV_TOKEN_VAR] = process.env[SPANNER_ENV_TOKEN_VAR];
    savedEnv.SPANNER_EMULATOR_HOST = process.env.SPANNER_EMULATOR_HOST;
    delete process.env[SPANNER_ENV_TOKEN_VAR];
    delete process.env.SPANNER_EMULATOR_HOST;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    statics.SPANNER = undefined;
    statics.SPANNER_INSTANCE = undefined;
    statics.SPANNER_DB = undefined;
    statics.LIVENESS_MONITOR = undefined;
    statics.ENV_TOKEN_AUTH = undefined;
    jest.restoreAllMocks();
  });

  describe('client-construction contract', () => {
    test('with the env token set (no emulator), the client carries the env-token credential — RPC headers are Bearer <env token>', async () => {
      process.env[SPANNER_ENV_TOKEN_VAR] = 'env-token-1';
      const spanner = internals(makeDriver()).getSpanner();

      // GoogleAuth caches the auth override verbatim (cachedCredential); gax turns it into
      // per-RPC call credentials — so this IS the credential every RPC authenticates with.
      const credential = spanner.auth.cachedCredential;
      expect(credential).toBeTruthy();
      expect(credential).toBe(statics.ENV_TOKEN_AUTH!.authClient);
      expect(await bearerOf(credential)).toBe('Bearer env-token-1');
    });

    test('with the env token absent, construction is ADC exactly as before — no auth override', () => {
      const spanner = internals(makeDriver()).getSpanner();

      expect(spanner.auth.cachedCredential).toBeNull();
      expect(spanner.options.authClient).toBeUndefined();
      expect(statics.ENV_TOKEN_AUTH).toBeUndefined();
    });

    test('SPANNER_EMULATOR_HOST wins: emulator construction ignores the env token (vendor short-circuits auth entirely)', () => {
      process.env.SPANNER_EMULATOR_HOST = 'localhost:9010';
      process.env[SPANNER_ENV_TOKEN_VAR] = 'env-token-ignored';
      const spanner = internals(makeDriver()).getSpanner();

      expect(spanner.auth.cachedCredential).toBeNull();
      expect(spanner.options.authClient).toBeUndefined();
      expect(statics.ENV_TOKEN_AUTH).toBeUndefined();
      // The vendor's emulator path: insecure channel creds, returned by gax before auth is
      // ever consulted (google-gax GrpcClient._getCredentials).
      expect(spanner.options.sslCreds).toBeTruthy();
    });
  });

  describe('expiry + rotation', () => {
    test('the mint re-reads the env: a rotated env token is served after invalidate(); the cached token stands until then', async () => {
      process.env[SPANNER_ENV_TOKEN_VAR] = 'token-v1';
      const auth = new SpannerEnvTokenAuth();

      expect(await bearerOf(auth.authClient)).toBe('Bearer token-v1');

      process.env[SPANNER_ENV_TOKEN_VAR] = 'token-v2';
      expect(await bearerOf(auth.authClient)).toBe('Bearer token-v1'); // cached until reread expiry

      auth.invalidate();
      expect(await bearerOf(auth.authClient)).toBe('Bearer token-v2');
    });

    test('a provided refresh hook owns the mint', async () => {
      process.env[SPANNER_ENV_TOKEN_VAR] = 'env-token-unused';
      let mints = 0;
      const auth = new SpannerEnvTokenAuth(async () => `hook-token-${++mints}`);

      expect(await bearerOf(auth.authClient)).toBe('Bearer hook-token-1');
      expect(await bearerOf(auth.authClient)).toBe('Bearer hook-token-1'); // cached, hook not re-invoked
      expect(mints).toBe(1);

      auth.invalidate();
      expect(await bearerOf(auth.authClient)).toBe('Bearer hook-token-2');
    });
  });

  describe('loud failure — no ADC fallback', () => {
    test('env token gone at refresh → typed error naming the env var and the rotation path', async () => {
      process.env[SPANNER_ENV_TOKEN_VAR] = 'token-v1';
      const auth = new SpannerEnvTokenAuth();
      expect(await bearerOf(auth.authClient)).toBe('Bearer token-v1');

      delete process.env[SPANNER_ENV_TOKEN_VAR];
      auth.invalidate();

      await expect(bearerOf(auth.authClient)).rejects.toThrow(SpannerEnvTokenAuthError);
      await expect(bearerOf(auth.authClient)).rejects.toThrow(new RegExp(SPANNER_ENV_TOKEN_VAR));
      await expect(bearerOf(auth.authClient)).rejects.toThrow(/re-configure|envTokenRefreshHook/);
    });

    test('a refresh hook returning nothing → the same typed loud failure', async () => {
      process.env[SPANNER_ENV_TOKEN_VAR] = 'selector-only';
      const auth = new SpannerEnvTokenAuth(() => undefined);

      await expect(bearerOf(auth.authClient)).rejects.toThrow(SpannerEnvTokenAuthError);
    });
  });

  describe('auth-failure translation on driver ops', () => {
    test('an UNAUTHENTICATED op in env-token mode surfaces the typed error and re-arms the mint (env re-read on next use)', async () => {
      process.env[SPANNER_ENV_TOKEN_VAR] = 'dead-token';
      const driver = makeDriver();
      internals(driver).getSpanner(); // real selection: installs the env-token credential
      statics.SPANNER_DB = { run: () => Promise.reject(unauthenticated()) };
      statics.LIVENESS_MONITOR = fakeMonitor;

      await expect(driver.runQuery(generateStatement)).rejects.toThrow(SpannerEnvTokenAuthError);
      await expect(driver.runQuery(generateStatement)).rejects.toThrow(new RegExp(SPANNER_ENV_TOKEN_VAR));
      // The rejection rides in the typed error's text as the driver's sentence for its status —
      // the backend's own message is never part of an error message the driver writes.
      await expect(driver.runQuery(generateStatement)).rejects.toThrow(/the backend rejected the credentials/);
      await expect(driver.runQuery(generateStatement)).rejects.not.toThrow(/invalid authentication credentials/);

      // The failure dropped the cached token: the next mint re-reads the (rotated) env.
      process.env[SPANNER_ENV_TOKEN_VAR] = 'fresh-token';
      expect(await bearerOf(statics.ENV_TOKEN_AUTH!.authClient)).toBe('Bearer fresh-token');
    });

    test('a schema-update UNAUTHENTICATED in env-token mode surfaces the typed error too', async () => {
      process.env[SPANNER_ENV_TOKEN_VAR] = 'dead-token';
      const driver = makeDriver();
      internals(driver).getSpanner();
      statics.SPANNER_DB = { updateSchema: () => Promise.reject(unauthenticated()) };
      statics.LIVENESS_MONITOR = fakeMonitor;

      await expect(driver.runUpdateSchema('CREATE TABLE t (id STRING(36)) PRIMARY KEY (id)')).rejects.toThrow(
        SpannerEnvTokenAuthError
      );
    });

    test('the typed auth error`s chain carries no vendor text: no `cause`, nothing a printer reaches — the vendor error rides behind vendorError', async () => {
      // A fixture shaped like content that must never be printed (not a real credential).
      const VALUE = 'rst_5d41402abc4b2a76b9719d911017c592';
      const text = `16 UNAUTHENTICATED: Request had invalid authentication credentials (${VALUE})`;
      const dead = Object.assign(new Error(text), { code: 16, details: text });
      process.env[SPANNER_ENV_TOKEN_VAR] = 'dead-token';
      const driver = makeDriver();
      internals(driver).getSpanner();
      statics.SPANNER_DB = { run: () => Promise.reject(dead), updateSchema: () => Promise.reject(dead) };
      statics.LIVENESS_MONITOR = fakeMonitor;
      const errorLines = (driver as any).logger.error as jest.Mock;

      const thrown: any[] = [
        await driver.runQuery(generateStatement).catch((error: unknown) => error),
        await driver
          .runUpdateSchema('CREATE TABLE t (id STRING(36)) PRIMARY KEY (id)')
          .catch((error: unknown) => error),
      ];

      for (const error of thrown) {
        expect(error).toBeInstanceOf(SpannerEnvTokenAuthError);
        expect(printed(error)).not.toContain(VALUE);
        expect('cause' in error).toBe(false);
        expect(Object.getOwnPropertyNames(error)).not.toContain('vendorError');
        // For a caller that asks for it by name — and only there.
        expect(error.vendorError).toBe(dead);
      }
      // Each failure's error line is handed the typed error; what a writer prints of it is value-free.
      expect(errorLines.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const [line] of errorLines.mock.calls) {
        expect(line.error).toBeInstanceOf(SpannerEnvTokenAuthError);
        expect(printed(line.error)).not.toContain(VALUE);
        expect(JSON.stringify(line.obj) ?? '').not.toContain(VALUE);
      }
      // An auth error with no vendor rejection behind it (a token that is gone) has none to carry.
      expect(new SpannerEnvTokenAuthError('no token').vendorError).toBeUndefined();
    });

    test('an UNAUTHENTICATED op in ADC mode passes through untranslated — the typed op error carries the vendor error behind vendorError; translation only exists in env-token mode', async () => {
      const driver = makeDriver();
      internals(driver).getSpanner(); // no env token: ADC, no env auth installed
      const dead = unauthenticated();
      statics.SPANNER_DB = { run: () => Promise.reject(dead) };
      statics.LIVENESS_MONITOR = fakeMonitor;

      await expect(driver.runQuery(generateStatement)).rejects.toMatchObject({ code: 16, vendorError: dead });
      await expect(driver.runQuery(generateStatement)).rejects.not.toBeInstanceOf(SpannerEnvTokenAuthError);
    });

    test('non-auth errors in env-token mode pass through untranslated (the vendor error rides behind vendorError, its code kept)', async () => {
      process.env[SPANNER_ENV_TOKEN_VAR] = 'live-token';
      const driver = makeDriver();
      internals(driver).getSpanner();
      const unavailable = Object.assign(new Error('UNAVAILABLE: channel drop'), { code: 14 });
      statics.SPANNER_DB = { run: () => Promise.reject(unavailable) };
      statics.LIVENESS_MONITOR = fakeMonitor;

      await expect(driver.runQuery(generateStatement)).rejects.toMatchObject({ code: 14, vendorError: unavailable });
      await expect(driver.runQuery(generateStatement)).rejects.not.toBeInstanceOf(SpannerEnvTokenAuthError);
    });
  });
});
