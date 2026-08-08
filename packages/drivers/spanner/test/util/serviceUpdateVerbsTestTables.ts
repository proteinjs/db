import {
  ObjectColumn,
  Record,
  ReferenceArray,
  ReferenceArrayColumn,
  StringColumn,
  Table,
  withRecordColumns,
} from '@proteinjs/db';

/**
 * Tables for `ServiceUpdateVerbs.test.ts` (the service-path RMW update verbs:
 * `updateArrayMembership` / `updatePreserving`).
 *
 * Defined here rather than in the test file so the reflection build registers them as `Table`
 * loadables — `tableByName` (which the db-service singleton and the `Table` wire serializer both
 * resolve through) must be able to find them for the test's RPC-boundary simulation.
 */

/**
 * Mutable stand-in for the ambient caller identity a scoped column reads (in production, the
 * session's user id). Tests reassign `current` to act as different callers.
 */
export const serviceVerbsScopeContext = { current: 'scope-a' };

export type ServiceVerbsDocBody = { content?: string; style?: { color?: string } };

export interface ServiceVerbsDoc extends Record {
  title: string;
  scope?: string;
  /** Self-referencing children list — the reference-array shape membership ops target. */
  members?: ReferenceArray<ServiceVerbsDoc>;
  /** Plain-JSON column with sub-path ownership split across writers (content vs style). */
  body?: ServiceVerbsDocBody;
}

/** Mirrors the generic scoped-record mechanism: scope forced on insert, immutable, injected into every non-system query. */
export class ServiceVerbsDocTable extends Table<ServiceVerbsDoc> {
  public name = 'db_test_service_update_verbs_doc';
  public columns = withRecordColumns<ServiceVerbsDoc>({
    title: new StringColumn('title'),
    scope: new StringColumn('scope', {
      defaultValue: async () => serviceVerbsScopeContext.current,
      forceDefaultValue: (runAsSystem) => !runAsSystem,
      immutable: (runAsSystem) => !runAsSystem,
      addToQuery: async (qb, runAsSystem) => {
        if (!runAsSystem) {
          qb.condition({ field: 'scope', operator: 'IN', value: [serviceVerbsScopeContext.current] });
        }
      },
    }),
    members: new ReferenceArrayColumn('members', 'db_test_service_update_verbs_doc', false),
    body: new ObjectColumn<ServiceVerbsDocBody>('body'),
  });
}
