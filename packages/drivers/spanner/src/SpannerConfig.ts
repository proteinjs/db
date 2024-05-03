import { SpannerOptions } from '@google-cloud/spanner'

export type SpannerConfig = {
  projectId: string,
  instanceName: string,
  databaseName: string,
  spannerOptions?: SpannerOptions,
}