import { SpannerOptions } from '@google-cloud/spanner';
import { SessionPoolOptions } from '@google-cloud/spanner/build/src/session-pool';

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
};
