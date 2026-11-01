import { Logger } from '@proteinjs/logger';
import { TableManager } from '../src/schema/TableManager';
import { TableChanges } from '../src/schema/SchemaOperations';
import { Table } from '../src/Table';
import { StringColumn } from '../src/Columns';
import { Record, withRecordColumns } from '../src/Record';

/**
 * The reconcile's handling of a table's RETIRED indexes, without a driver: a live index the table
 * declares retired is dropped by its name wherever it stands — unique-suffixed or not — while an
 * undeclared unique index is kept as before, a plain undeclared index dropped as before, nothing
 * asked of the driver when no retired index stands, and a name both declared and retired refused
 * before any schema is read.
 *
 * Judged by outcomes: what the driver is asked to drop and create, the lines the sync writes
 * (one per drop, names only), and whether a schema read happened at all.
 */

interface Member extends Record {
  email: string;
  team: string;
}

const TABLE_NAME = 'member';
const RETIRED = `${TABLE_NAME}_email_unique`;
const DECLARED = `${TABLE_NAME}_team_email_unique`;
type Index = { name?: string; columns: (keyof Member)[]; unique?: boolean };

/** The member table, declaring `indexes` and retiring `retired`. */
const tableWhere = (
  retired: string[],
  indexes: Index[] = [{ name: DECLARED, columns: ['team', 'email'], unique: true }],
  email: StringColumn = new StringColumn('email')
): Table<Member> =>
  new (class extends Table<Member> {
    public name = TABLE_NAME;
    public columns = withRecordColumns<Member>({
      email,
      team: new StringColumn('team'),
    });
    public indexes = indexes;
    public retiredIndexes = retired;
  })();

type CapturedLog = { logLevel: string; message?: string; obj?: any };
type Live = { [indexName: string]: string[] };
/** House-style access to the reconcile's internals: a typed cast on the instance, never a public method. */
type ManagerInternals = {
  logger: Logger;
  alterTableIfChanged(table: Table<any>): Promise<void>;
  loadSingleTable(table: Table<any>): Promise<void>;
  validateRetiredIndexes(table: Table<any>): void;
};

/** Every column as declared, so the only differences the reconcile can find are the indexes. */
const liveColumns = () => {
  const columns: { [columnName: string]: { type: string; isNullable: boolean } } = {};
  for (const columnName of ['id', 'created', 'updated', 'email', 'team']) {
    columns[columnName] = { type: 'STRING(255)', isNullable: true };
  }

  return columns;
};

describe('retired indexes at the reconcile', () => {
  let captured: CapturedLog[];
  let altered: TableChanges[];
  let schemaReads: number;

  /** A manager over a table whose live indexes are `live`, reached through its internals. */
  const managerWhere = (live: Live): ManagerInternals => {
    const manager = new TableManager(
      { getDbName: () => 'test', runQuery: async () => [] } as never,
      { getType: () => 'STRING(255)' } as never,
      { alterTable: async (_table: Table<any>, changes: TableChanges) => altered.push(changes) } as never,
      {
        tableExists: async () => {
          schemaReads += 1;
          return true;
        },
        getColumnMetadata: async () => liveColumns(),
        getUniqueColumns: async () => [],
        getForeignKeys: async () => ({}),
        getIndexes: async () => live,
      } as never
    );
    const internals = manager as unknown as ManagerInternals;
    internals.logger = new Logger({
      name: 'TableManager',
      logWriter: { write: (log: CapturedLog) => captured.push(log) } as never,
    });
    return internals;
  };

  const retiredLines = () =>
    captured.filter((log) => log.logLevel === 'info' && /Dropping retired index/.test(log.message ?? ''));

  beforeEach(() => {
    captured = [];
    altered = [];
    schemaReads = 0;
  });

  test('a live index the table declares retired is dropped by name, and the declared index stands', async () => {
    await managerWhere({
      PRIMARY_KEY: ['id'],
      [DECLARED]: ['team', 'email'],
      [RETIRED]: ['email'],
    }).alterTableIfChanged(tableWhere([RETIRED]));

    expect(altered).toHaveLength(1);
    expect(altered[0].indexesToDrop).toEqual([{ name: RETIRED, columns: ['email'] }]);
    expect(altered[0].indexesToCreate).toEqual([]);
    expect(retiredLines().map((log) => log.message)).toEqual([
      `[${TABLE_NAME}] Dropping retired index: ${RETIRED} (email) — the table declares it retired`,
    ]);
    expect(retiredLines()[0].obj).toEqual({ table: TABLE_NAME, index: RETIRED, columns: ['email'] });
  });

  test('a retired name is dropped whatever its suffix: a plain index name retired is dropped too', async () => {
    const plain = `${TABLE_NAME}_by_team`;

    await managerWhere({ PRIMARY_KEY: ['id'], [DECLARED]: ['team', 'email'], [plain]: ['team'] }).alterTableIfChanged(
      tableWhere([plain])
    );

    expect(altered).toHaveLength(1);
    expect(altered[0].indexesToDrop).toEqual([{ name: plain, columns: ['team'] }]);
    expect(retiredLines()).toHaveLength(1);
  });

  test('a database born under the retired index: the retired index is dropped and the declared one created in one pass', async () => {
    await managerWhere({ PRIMARY_KEY: ['id'], [RETIRED]: ['email'] }).alterTableIfChanged(tableWhere([RETIRED]));

    expect(altered).toHaveLength(1);
    expect(altered[0].indexesToDrop).toEqual([{ name: RETIRED, columns: ['email'] }]);
    expect(altered[0].indexesToCreate).toEqual([{ name: DECLARED, columns: ['team', 'email'], unique: true }]);
    expect(retiredLines()).toHaveLength(1);
  });

  test('an undeclared unique index is kept and an undeclared plain index dropped, as before; no retired line', async () => {
    const stranger = `${TABLE_NAME}_stranger_unique`;
    const stale = `${TABLE_NAME}_stale_index`;

    await managerWhere({
      PRIMARY_KEY: ['id'],
      [DECLARED]: ['team', 'email'],
      [stranger]: ['email'],
      [stale]: ['team'],
    }).alterTableIfChanged(tableWhere([]));

    expect(altered).toHaveLength(1);
    expect(altered[0].indexesToDrop).toEqual([{ name: stale, columns: ['team'] }]);
    expect(retiredLines()).toEqual([]);
  });

  test('no retired index standing: nothing is asked of the driver and no line is written', async () => {
    await managerWhere({ PRIMARY_KEY: ['id'], [DECLARED]: ['team', 'email'] }).alterTableIfChanged(
      tableWhere([RETIRED])
    );

    expect(altered).toEqual([]);
    expect(retiredLines()).toEqual([]);
  });

  describe('a name both declared and retired is a contradiction, refused before any schema is read', () => {
    test('by the declared name', async () => {
      const manager = managerWhere({ PRIMARY_KEY: ['id'] });

      await expect(manager.loadSingleTable(tableWhere([DECLARED]))).rejects.toThrow(
        `(${TABLE_NAME}) An index cannot be both declared and retired: ${DECLARED}. Remove it from \`indexes\` to ` +
          'retire it, or from `retiredIndexes` to keep it'
      );

      expect(schemaReads).toBe(0);
      expect(altered).toEqual([]);
    });

    test('by the derived name of an index declared without one', async () => {
      const manager = managerWhere({ PRIMARY_KEY: ['id'] });

      await expect(
        manager.loadSingleTable(tableWhere([`${TABLE_NAME}_email_unique`], [{ columns: ['email'], unique: true }]))
      ).rejects.toThrow(`An index cannot be both declared and retired: ${TABLE_NAME}_email_unique`);

      expect(schemaReads).toBe(0);
    });

    test('by the name of a column’s unique index', async () => {
      const manager = managerWhere({ PRIMARY_KEY: ['id'] });
      const uniqueEmail = new StringColumn('email', { unique: { unique: true, indexName: 'member_mail_unique' } });

      await expect(manager.loadSingleTable(tableWhere(['member_mail_unique'], [], uniqueEmail))).rejects.toThrow(
        'An index cannot be both declared and retired: member_mail_unique'
      );

      expect(schemaReads).toBe(0);
    });

    test('every contradiction is named at once', () => {
      const manager = managerWhere({ PRIMARY_KEY: ['id'] });

      expect(() => manager.validateRetiredIndexes(tableWhere([DECLARED, RETIRED, 'member_by_team']))).toThrow(
        `An index cannot be both declared and retired: ${DECLARED}`
      );
      expect(() => manager.validateRetiredIndexes(tableWhere([RETIRED, 'member_by_team']))).not.toThrow();
    });
  });
});
