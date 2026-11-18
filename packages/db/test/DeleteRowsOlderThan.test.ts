import { Logger } from '@proteinjs/logger';
import { SourceRepository } from '@proteinjs/reflection';
import { TableManager } from '../src/schema/TableManager';
import { LiveDeleteRowsOlderThan, TableChanges } from '../src/schema/SchemaOperations';
import { Table } from '../src/Table';
import { DateTimeColumn, ReferenceArrayColumn, StringColumn } from '../src/Columns';
import { Record, withRecordColumns } from '../src/Record';
import { moment } from '../src/opt/moment';

/**
 * A table's declared age-out (`Table.deleteRowsOlderThan`) at the reconcile, without a driver: what
 * the driver is asked to add to a table that already exists, that a standing age-out is never
 * changed (the schema only moves forward), that a table declaring nothing is never read, and what
 * is refused at table load before any schema is read.
 *
 * Judged by outcomes: the change the driver is handed, the line the sync writes, whether the live
 * age-out was read at all, and the refusal's words.
 */

interface Visit extends Record {
  seenAt?: moment.Moment;
  note?: string;
}

const TABLE_NAME = 'visit';
type Declared = Table<Visit>['deleteRowsOlderThan'];

/** The visit table declaring `declared`; `seenAt` is stored as `seen_at`, so a stored name is told from a property. */
const tableWhere = (declared: Declared, more: Partial<Table<any>> = {}): Table<Visit> =>
  Object.assign(
    new (class extends Table<Visit> {
      public name = TABLE_NAME;
      public columns = withRecordColumns<Visit>({
        seenAt: new DateTimeColumn('seen_at'),
        note: new StringColumn('note'),
      });
      public deleteRowsOlderThan = declared;
    })(),
    more
  );

type CapturedLog = { logLevel: string; message?: string; obj?: any };
/** House-style access to the reconcile's internals: a typed cast on the instance, never a public method. */
type ManagerInternals = {
  logger: Logger;
  alterTableIfChanged(table: Table<any>): Promise<void>;
  loadSingleTable(table: Table<any>): Promise<void>;
  loadTables(): Promise<void>;
};

/** Every column as declared, so the only difference the reconcile can find is the age-out. */
const liveColumns = () => {
  const columns: { [columnName: string]: { type: string; isNullable: boolean } } = {};
  for (const columnName of ['id', 'created', 'updated', 'seen_at', 'note']) {
    columns[columnName] = { type: 'ANY', isNullable: true };
  }

  return columns;
};

describe('a declared age-out at the reconcile', () => {
  let captured: CapturedLog[];
  let altered: TableChanges[];
  let created: string[];
  let schemaReads: number;
  let ageOutReads: number;

  /**
   * A manager over a table that exists and carries the age-out `live`. `live` undefined is a driver
   * whose database has no age-out of its own: its metadata reader has no such read.
   */
  const managerWhere = (live: LiveDeleteRowsOlderThan | null | undefined): ManagerInternals => {
    const count = <T>(value: T): T => {
      schemaReads += 1;
      return value;
    };
    const manager = new TableManager(
      { getDbName: () => 'test', runQuery: async () => [] } as never,
      { getType: () => 'ANY' } as never,
      {
        alterTable: async (_table: Table<any>, changes: TableChanges) => altered.push(changes),
        createTables: async (tables: Table<any>[]) => created.push(...tables.map((table) => table.name)),
      } as never,
      {
        tableExists: async () => count(true),
        getColumnMetadata: async () => count(liveColumns()),
        getUniqueColumns: async () => count([]),
        getForeignKeys: async () => count({}),
        getIndexes: async () => count({ PRIMARY_KEY: ['id'] }),
        ...(live === undefined
          ? {}
          : {
              getDeleteRowsOlderThan: async () => {
                ageOutReads += 1;
                return live;
              },
            }),
      } as never
    );
    const internals = manager as unknown as ManagerInternals;
    internals.logger = new Logger({
      name: 'TableManager',
      logWriter: { write: (log: CapturedLog) => captured.push(log) } as never,
    });
    return internals;
  };

  const ageOutLines = () => captured.filter((log) => /Rows the database deletes by age/.test(log.message ?? ''));

  beforeEach(() => {
    captured = [];
    altered = [];
    created = [];
    schemaReads = 0;
    ageOutReads = 0;
  });

  test('declared where the live table carries none: the driver is asked to add it, by the column’s stored name', async () => {
    await managerWhere(null).alterTableIfChanged(tableWhere({ column: 'seenAt', days: 7 }));

    expect(altered).toHaveLength(1);
    expect(altered[0].deleteRowsOlderThanToAdd).toEqual({ column: 'seen_at', days: 7 });
    expect(ageOutLines().map((log) => [log.logLevel, log.message])).toEqual([
      ['info', `[${TABLE_NAME}] Rows the database deletes by age: seen_at older than 7 days (the live table: none)`],
    ]);
  });

  test('the live age-out is the declared one: nothing reaches the driver and no line is written', async () => {
    await managerWhere({ column: 'seen_at', days: 7 }).alterTableIfChanged(tableWhere({ column: 'seenAt', days: 7 }));

    expect(ageOutReads).toBe(1);
    expect(altered).toEqual([]);
    expect(ageOutLines()).toEqual([]);
  });

  test.each<[string, LiveDeleteRowsOlderThan]>([
    ['other days', { column: 'seen_at', days: 30 }],
    ['another column', { column: 'created', days: 7 }],
    ['a text the driver could not read as a column and days', { unread: 'OLDER_THAN(seen_at, INTERVAL 1 WEEK)' }],
  ])(
    'a standing age-out that is not the declared one (%s) is left as it stands: nothing reaches the driver, and both are named',
    async (_name, live) => {
      await managerWhere(live).alterTableIfChanged(tableWhere({ column: 'seenAt', days: 7 }));

      expect(altered).toEqual([]);
      expect(ageOutLines().map((log) => [log.logLevel, log.obj])).toEqual([
        ['warn', { table: TABLE_NAME, declared: { column: 'seen_at', days: 7 }, live }],
      ]);
    }
  );

  test('a table that declares nothing is never read and never changed, whatever stands on it', async () => {
    await managerWhere({ column: 'seen_at', days: 7 }).alterTableIfChanged(tableWhere(undefined));

    expect(ageOutReads).toBe(0);
    expect(altered).toEqual([]);
  });

  test.each<[string, Declared, Partial<Table<any>>, RegExp]>([
    ['a column the table does not declare', { column: 'seen' as never, days: 7 }, {}, /declares no column 'seen'/],
    ['a column that holds no time', { column: 'note', days: 7 }, {}, /'note' is not a time column/],
    ['no days', { column: 'seenAt', days: 0 }, {}, /whole number of days, 1 or more \(declared: 0\)/],
    ['part of a day', { column: 'seenAt', days: 1.5 }, {}, /whole number of days, 1 or more \(declared: 1.5\)/],
    [
      'a table that cascades its deletes',
      { column: 'seenAt', days: 7 },
      { cascadeDeleteReferences: () => [{ table: 'visit_note', referenceColumn: 'visit' }] },
      /would skip the work this table gives a delete: cascadeDeleteReferences/,
    ],
    [
      'a column whose references go with the row',
      { column: 'seenAt', days: 7 },
      {
        columns: withRecordColumns<any>({
          seenAt: new DateTimeColumn('seen_at'),
          notes: new ReferenceArrayColumn('notes', 'visit_note', true),
        }),
      },
      /would skip the work this table gives a delete: notes.beforeDelete/,
    ],
    [
      // A table of its own name: the search rows' table is registered by the table's name for the whole run.
      'a column whose search rows go with the row',
      { column: 'seenAt', days: 7 },
      {
        name: `${TABLE_NAME}_searched`,
        columns: withRecordColumns<any>({
          seenAt: new DateTimeColumn('seen_at'),
          note: new StringColumn('note', { encrypted: { searchable: 'contains' } }),
        }),
      },
      /would skip the work this table gives a delete: a searchable encrypted column/,
    ],
  ])('refused at table load, before any schema is read: %s', async (_name, declared, more, reason) => {
    const table = tableWhere(declared, more);
    const load = managerWhere(null).loadSingleTable(table);

    await expect(load).rejects.toThrow(reason);
    await expect(load).rejects.toThrow(`(${table.name}) deleteRowsOlderThan cannot be declared`);
    expect(schemaReads).toBe(0);
    expect(created).toEqual([]);
  });

  test('a driver whose database has no age-out: a declared one is refused at load; a table that declares nothing loads as before', async () => {
    const load = managerWhere(undefined).loadSingleTable(tableWhere({ column: 'seenAt', days: 7 }));
    await expect(load).rejects.toThrow(
      `(${TABLE_NAME}) deleteRowsOlderThan cannot be declared: this driver's database has no age-out of its own, so the rows would never leave`
    );
    expect(schemaReads).toBe(0);
    expect(created).toEqual([]);

    await managerWhere(undefined).loadSingleTable(tableWhere(undefined));
    expect(altered).toEqual([]);
  });

  test('at a server’s whole start too: the refusal comes before anything is written for any table', async () => {
    const refused = tableWhere({ column: 'seenAt', days: 7 }, { name: `${TABLE_NAME}_aged` });
    // The registry of this start: two tables, and nothing else registered (no encryption config).
    const objects = jest
      .spyOn(SourceRepository.get(), 'objects')
      .mockImplementation(((type: string) =>
        type === '@proteinjs/db/Table' ? [tableWhere(undefined), refused] : []) as any);
    try {
      await expect(managerWhere(undefined).loadTables()).rejects.toThrow(
        `(${refused.name}) deleteRowsOlderThan cannot be declared: this driver's database has no age-out of its own`
      );
    } finally {
      objects.mockRestore();
    }

    expect(created).toEqual([]);
    expect(altered).toEqual([]);
  });
});
