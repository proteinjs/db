import { Record, StringColumn, Table, withRecordColumns } from '@proteinjs/db';
import { SpannerDriver } from '@proteinjs/db-driver-spanner';
import { getDropTestTable } from './util/getDropTestTable';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';
import '../generated/test/index';

/**
 * A retired index dropped under contention. On a schema-changing release the migration job, the
 * booting pods and every replica run the schema sync at once; each observes the index its table
 * declares retired and each issues the DROP. Spanner serializes the DDL so the index leaves exactly
 * once, and the loser's DROP fails NOT_FOUND — the drop-side mirror of the concurrent create that
 * `TableManager.reconcileConcurrentSchemaChange` closes with `isAlreadyExistsError`. The loser must
 * complete: the re-read finds the index gone and the declared schema whole.
 *
 * The classifier is the first gate and matches ONE class — NOT_FOUND for an INDEX — so a missing
 * table or a duplicate never slips through it.
 */

const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};

const spannerDriver = new SpannerDriver(spannerConfig);
const TABLE_NAME = 'db_test_retired_drop';
const RETIRED = `${TABLE_NAME}_email_unique`;
const DECLARED = `${TABLE_NAME}_team_email_unique`;

interface Member extends Record {
  email?: string;
  team?: string;
}

/** The member table: the widened unique index declared, the narrow one retired. */
const memberTable = (): Table<Member> =>
  new (class extends Table<Member> {
    name = TABLE_NAME;
    columns = withRecordColumns<Member>({
      email: new StringColumn('email'),
      team: new StringColumn('team'),
    });
    indexes = [{ name: DECLARED, columns: ['team', 'email'] as (keyof Member)[], unique: true }];
    retiredIndexes = [RETIRED];
  })();

type SpannerTableManager = ReturnType<SpannerDriver['getTableManager']>;

/** House-style access to the driver-specific classifiers. */
const classifier = (tableManager: SpannerTableManager) =>
  tableManager.schemaOperations as unknown as {
    isAlreadyExistsError(error: unknown): boolean;
    isAlreadyAbsentError(error: unknown): boolean;
  };

/** The instance's own logger.warn (a typed cast, house style): the reconcile's lines. */
const spyOnReconcileWarn = (tableManager: SpannerTableManager) =>
  jest.spyOn((tableManager as unknown as { logger: { warn: (log: { message?: unknown }) => void } }).logger, 'warn');

const ddlError = async (statement: string): Promise<unknown> => {
  try {
    await spannerDriver.runUpdateSchema(statement);
  } catch (error) {
    return error;
  }
  throw new Error(`expected the statement to fail: ${statement}`);
};

describe('a retired index dropped under contention', () => {
  const dropTable = getDropTestTable(spannerDriver);
  const tableManager = spannerDriver.getTableManager();

  beforeAll(async () => {
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
  }, 60000);

  beforeEach(async () => {
    await dropTable(memberTable());
  }, 60000);

  afterAll(async () => {
    await dropTable(memberTable());
    SpannerEmulatorProvisioner.release();
  }, 60000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('two actors dropping the SAME retired index both succeed; the index leaves once', async () => {
    // The shape a database born under the narrow index carries, with the widened one already made.
    await tableManager.loadTable(memberTable());
    await spannerDriver.runUpdateSchema(`CREATE UNIQUE INDEX ${RETIRED} ON ${TABLE_NAME}(email)`);

    // Winner: drops the retired index for real.
    await tableManager.loadTable(memberTable());
    expect(await tableManager.schemaMetadata.getIndexes(memberTable())).not.toHaveProperty(RETIRED);

    // Loser: a second reconciler whose PLANNING read is forced stale (the retired index still
    // standing), so it issues the real `DROP INDEX` that the backend refuses as not found.
    // mockImplementationOnce affects only the planning read; the reconcile's own verification
    // re-read sees the true (post-winner) schema.
    const loserTm = spannerDriver.getTableManager();
    const realGetIndexes = loserTm.schemaMetadata.getIndexes.bind(loserTm.schemaMetadata);
    jest.spyOn(loserTm.schemaMetadata, 'getIndexes').mockImplementationOnce(async (table) => ({
      ...(await realGetIndexes(table)),
      [RETIRED]: ['email'],
    }));
    const loserWarnSpy = spyOnReconcileWarn(loserTm);

    // OUTCOME: the loser's sync completes — the not-found error is reconciled to success.
    await expect(loserTm.loadTable(memberTable())).resolves.toBeUndefined();

    // OBSERVABILITY: the tolerance fired loudly, naming the table and the class.
    const toleratedWarn = loserWarnSpy.mock.calls.find(([entry]) =>
      /\[schema reconcile\] tolerated concurrent NOT_FOUND/.test(String(entry.message))
    );
    expect(toleratedWarn).toBeDefined();
    expect(String(toleratedWarn![0].message)).toContain(TABLE_NAME);

    // The schema stands as declared: the retired index gone, the declared one whole.
    const indexes = await tableManager.schemaMetadata.getIndexes(memberTable());
    expect(indexes[RETIRED]).toBeUndefined();
    expect(indexes[DECLARED]).toEqual(['team', 'email']);
  }, 60000);

  test('a DROP of a missing index is the not-found class; a missing table or a duplicate is not', async () => {
    await tableManager.loadTable(memberTable());

    const missingIndex = await ddlError(`DROP INDEX ${RETIRED}`);
    expect(classifier(tableManager).isAlreadyAbsentError(missingIndex)).toBe(true);
    expect(classifier(tableManager).isAlreadyExistsError(missingIndex)).toBe(false);

    const missingTable = await ddlError(`DROP TABLE ${TABLE_NAME}_no_such_table`);
    expect(classifier(tableManager).isAlreadyAbsentError(missingTable)).toBe(false);

    const duplicate = await ddlError(`CREATE UNIQUE INDEX ${DECLARED} ON ${TABLE_NAME}(team, email)`);
    expect(classifier(tableManager).isAlreadyAbsentError(duplicate)).toBe(false);
    expect(classifier(tableManager).isAlreadyExistsError(duplicate)).toBe(true);
  }, 60000);

  test('classifier matches ONLY the index-not-found class — by code AND message class', () => {
    const isAlreadyAbsent = (code: number | undefined, message: string) =>
      classifier(tableManager).isAlreadyAbsentError({ code, message });

    expect(isAlreadyAbsent(5, `5 NOT_FOUND: Index not found: ${RETIRED}`)).toBe(true);

    // NOT matched — other missing objects under NOT_FOUND: the sync drops neither.
    expect(isAlreadyAbsent(5, `5 NOT_FOUND: Table not found: ${TABLE_NAME}`)).toBe(false);
    expect(isAlreadyAbsent(5, `5 NOT_FOUND: Column not found in table ${TABLE_NAME}: email`)).toBe(false);

    // NOT matched — right message, wrong code.
    expect(isAlreadyAbsent(9, `9 FAILED_PRECONDITION: Index not found: ${RETIRED}`)).toBe(false);
    expect(isAlreadyAbsent(3, `3 INVALID_ARGUMENT: Index not found: ${RETIRED}`)).toBe(false);

    // NOT matched — reconcile-layer errors are plain Errors with no `code`.
    expect(classifier(tableManager).isAlreadyAbsentError(new Error('Index not found'))).toBe(false);
    expect(classifier(tableManager).isAlreadyAbsentError(undefined)).toBe(false);
  });
});
