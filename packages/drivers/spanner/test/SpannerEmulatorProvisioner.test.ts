import { Spanner, Database, Transaction } from '@google-cloud/spanner';
import { SpannerEmulatorProvisioner } from './util/SpannerEmulatorProvisioner';

const spannerConfig = {
  projectId: 'proteinjs-test',
  instanceName: 'proteinjs-test',
  databaseName: 'test',
};

const SCRATCH_TABLE = 'db_test_provisioner_reensure';

const retentionRows = async (database: Database) => {
  const [rows] = await database.run({
    sql: `SELECT s.OPTION_VALUE FROM INFORMATION_SCHEMA.DATABASE_OPTIONS s WHERE s.OPTION_NAME = 'version_retention_period'`,
    json: true,
  });
  return rows as { OPTION_VALUE: string }[];
};

/**
 * The provisioner's re-ensure invariant (see the class doc): `ensureProvisioned` on an
 * already-provisioned, already-pinned emulator issues ZERO DDL. It runs in every fresh
 * process's first beforeAll, and fresh processes appear MID-RUN (jest workerIdleMemoryLimit
 * restarts) — right after a predecessor process was killed with a read-write transaction in
 * flight. The emulator rejects ANY schema change while such a transaction is active, so a
 * re-ensure that emits DDL fails whole suites with FAILED_PRECONDITION (the 11-suite
 * flow-server CI failure, run 31643570286).
 *
 * The tests assert OUTCOMES against a real open read-write transaction — no mocks: a control
 * leg first proves the open transaction really does reject DDL right now, so `ensureProvisioned`
 * resolving in the same window proves it issued none.
 */
describe('SpannerEmulatorProvisioner', () => {
  const spanner = new Spanner({ projectId: spannerConfig.projectId });
  let database: Database;

  beforeAll(async () => {
    // The run's one legitimate DDL window: on a fresh emulator this creates instance +
    // database and pins retention; on a provisioned one it must reconcile without DDL.
    await SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig);
    database = spanner.instance(spannerConfig.instanceName).database(spannerConfig.databaseName);
    database.on('error', () => undefined);
  }, 60_000);

  afterAll(async () => {
    await database.close().catch(() => undefined);
    spanner.close();
    SpannerEmulatorProvisioner.release();
  }, 60_000);

  test('pins version_retention_period on a fresh or unpinned database', async () => {
    // Outcome of the beforeAll ensure: the option is present and pinned. Guards the skip
    // condition from ever decaying into never-pinning.
    const rows = await retentionRows(database);
    expect(rows).toEqual([{ OPTION_VALUE: '1m' }]);
  }, 30_000);

  test('re-ensure issues zero DDL: succeeds while an open read-write transaction rejects all schema changes', async () => {
    // Scratch table for the transaction's uncommitted write — created BEFORE the transaction
    // opens (DDL is legal here), only when a previous run didn't leave it behind.
    const [tables] = await database.run({
      sql: `SELECT t.TABLE_NAME FROM INFORMATION_SCHEMA.TABLES t WHERE t.TABLE_SCHEMA = '' AND t.TABLE_NAME = '${SCRATCH_TABLE}'`,
      json: true,
    });
    if (tables.length === 0) {
      const [createOp] = await database.updateSchema(`CREATE TABLE ${SCRATCH_TABLE} (id STRING(36)) PRIMARY KEY (id)`);
      await createOp.promise();
    }

    // Model the stranded transaction a killed jest worker leaves behind: a read-write
    // transaction with real uncommitted work, held open across the re-ensure.
    //
    // The control's premise — OUR transaction is the active one when the DDL arrives — can be
    // invalidated by ambient in-process writers (session-pool maintenance, neighbor suites'
    // detached work): the emulator allows ONE active read-write transaction, so a neighbor's
    // write aborts ours mid-window and the DDL sails through. That is a false alarm, not the
    // invariant breaking (bit twice on CI run 31760208027 once the suite set grew). Each
    // attempt re-establishes the premise; the control only FAILS when DDL succeeds against a
    // transaction verified still active.
    let transaction: Transaction | undefined;
    try {
      // Emulator-semantics detection, not a mocked assumption: newer emulator images ALLOW
      // schema changes while a read-write transaction is active (the real service always
      // did), where older images reject with FAILED_PRECONDITION. The stranded-transaction
      // failure class this invariant guards exists exactly where the rejection does — so the
      // control leg doubles as the detector. Probe soundness: after an unexpected DDL
      // success, COMMIT the held transaction — commit of a neighbor-aborted transaction
      // throws ABORTED (retry: the premise was invalidated, not the semantics), commit of a
      // still-active one succeeds (rejection semantics genuinely absent on this emulator).
      // A SELECT probe is unsound here: an aborted handle can silently re-begin and answer.
      let controlHeld = false;
      let rejectionSemanticsAbsent = false;
      for (let attempt = 0; attempt < 3 && !controlHeld && !rejectionSemanticsAbsent; attempt++) {
        if (transaction) {
          await transaction.rollback().catch(() => undefined);
          transaction.end();
        }
        [transaction] = (await database.getTransaction()) as unknown as [Transaction];
        await transaction.runUpdate({
          sql: `INSERT INTO ${SCRATCH_TABLE} (id) VALUES (@id)`,
          params: { id: `re-ensure-${attempt}-${Date.now()}` },
        });

        // Control leg: on rejecting emulators the open transaction refuses DDL in this
        // window — the same rejection the pre-fix unconditional pin ALTER died on.
        try {
          const [op] = await database.updateSchema(
            `ALTER DATABASE \`${spannerConfig.databaseName}\` SET OPTIONS (version_retention_period = '1m')`
          );
          await op.promise();
        } catch (error) {
          expect(error).toMatchObject({ code: 9 /* gRPC FAILED_PRECONDITION */ });
          controlHeld = true;
        }
        if (controlHeld) {
          break;
        }

        rejectionSemanticsAbsent = await transaction.commit().then(
          () => true,
          () => false
        );
      }

      if (rejectionSemanticsAbsent) {
        // DDL succeeded against a verifiably-active transaction: this emulator does not
        // reject schema changes under open transactions, so a stranded transaction cannot
        // fail a re-ensure here — the invariant's failure class is absent by construction.
        // The reconcile leg below still bites: re-ensure resolves and retention stays pinned.
        transaction?.end();
        transaction = undefined;
      } else if (!controlHeld) {
        throw new Error(
          'control could not hold an active transaction across 3 attempts — ambient writers kept aborting it'
        );
      }

      // The invariant: re-ensure resolves inside the same window — it issued zero DDL.
      await expect(SpannerEmulatorProvisioner.ensureProvisioned(spannerConfig)).resolves.toBeUndefined();

      // And it reconciled rather than skipped: retention still reads pinned.
      const rows = await retentionRows(database);
      expect(rows).toEqual([{ OPTION_VALUE: '1m' }]);
    } finally {
      // Never strand the transaction on the shared test emulator — that would poison later
      // suites' DDL exactly like the class this test guards against.
      if (transaction) {
        await transaction.rollback().catch(() => undefined);
        transaction.end();
      }
    }
  }, 60_000);
});
