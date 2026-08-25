import { SpannerOptions } from '@google-cloud/spanner';
import { SessionPoolOptions } from '@google-cloud/spanner/build/src/session-pool';
import { SpannerEnvTokenRefreshHook } from './SpannerEnvTokenAuth';

export type SpannerConfig = {
  projectId: string;
  instanceName: string;
  databaseName: string;
  spannerOptions?: SpannerOptions;
  /**
   * Session pool options passed through to `Instance.database()` (library defaults apply when
   * omitted). Note: the driver's Database is a process-wide singleton — the first driver to
   * touch the db fixes the pool for the process, like `spannerOptions`.
   */
  sessionPoolOptions?: SessionPoolOptions;
  /**
   * Deadline applied to every query/dml/transaction op (default 60_000ms). An op that has not
   * settled by the deadline FAILS with an error naming the deadline instead of hanging forever
   * on a dead gRPC channel (the 2026-08-06 overnight wedge: Mac sleep killed the channel, every
   * in-flight op hung, borrowed sessions never returned, pending ops OOM'd the heap). The same
   * value is passed as the gRPC deadline (`gaxOptions.timeout`) so the library cancels the RPC
   * and returns the op's session to the pool. Schema updates (DDL) are exempt — they are
   * legitimately long-running.
   */
  operationDeadlineMs?: number;
  /**
   * Consecutive op-deadline failures that trigger a recycle of the process-wide Spanner
   * client/channel (default 3). Any op success resets the count.
   */
  deadlineFailuresBeforeRecycle?: number;
  /**
   * In-run token refresh for env-token auth: when the driver is running on an env-delivered
   * access token (`CLOUDSDK_AUTH_ACCESS_TOKEN` present at client construction) and the token
   * expires or is rejected mid-run, this hook mints the replacement. Default (no hook): re-read
   * the env var. Only consulted in env-token mode — it never turns ADC into env-token auth, and
   * a hook that returns nothing is a loud `SpannerEnvTokenAuthError`, never an ADC fallback.
   */
  envTokenRefreshHook?: SpannerEnvTokenRefreshHook;
};
